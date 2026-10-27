import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  createApiCaptureRepository,
  createTaskExtractionRepository,
  createTaskRepository,
} from "@pce/db";
import {
  changeTask,
  getNote,
  getTask,
  getTaskHistory,
  getTasks,
  removeNote,
  saveTaskBatch,
  setNoteArchived,
  type AuthenticatedRequestOptions,
  type TaskExtractionBatch,
} from "@pce/api-client";
import { createApp } from "./app.js";
import { createDatabaseNoteReader } from "./database-reader.js";
import { createSessionAuth } from "./session-auth.js";

describe.skipIf(!process.env.PCE_DB_TEST_URL)(
  "cross-surface Task acceptance with synthetic originals",
  () => {
    const owner = "task-acceptance-" + randomUUID();
    const noteId = randomUUID(),
      captureId = randomUUID();
    const origin = "http://127.0.0.1:4310";
    let db: PrismaClient;
    const apps: ReturnType<typeof createApp>[] = [];
    beforeAll(async () => {
      db = new PrismaClient({
        datasources: { db: { url: process.env.PCE_DB_TEST_URL! } },
      });
      await db.$connect();
    });
    afterAll(async () => {
      await Promise.all(apps.map((app) => app.close()));
      if (!db) return;
      await db.taskExtractionBatch.deleteMany({
        where: { ownerSubject: owner },
      });
      await db.taskSource.deleteMany({ where: { ownerSubject: owner } });
      await db.taskCommand.deleteMany({ where: { ownerSubject: owner } });
      await db.taskEvent.deleteMany({ where: { ownerSubject: owner } });
      await db.task.deleteMany({ where: { ownerSubject: owner } });
      await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
      await db.note.deleteMany({ where: { id: noteId, ownerSubject: owner } });
      await db.capture.deleteMany({ where: { id: captureId } });
      await db.authSession.deleteMany({ where: { ownerSubject: owner } });
      await db.$disconnect();
    });
    it("preserves three independent Tasks, source privacy and history through feature rollback/reactivation", async () => {
      const makeApp = (enabled: boolean) => {
        const app = createApp({
          config: {
            environment: "test",
            host: "127.0.0.1",
            port: 3110,
            requiresDatabase: false,
            corsOrigin: origin,
            auth: null,
          },
          dependencies: {
            sessionAuth: createSessionAuth(db, {
              mode: "dev-single-user",
              ownerSubject: owner,
              origin,
              issuer: "http://127.0.0.1:3110",
              audience: "http://127.0.0.1:3110/mcp",
              secure: false,
            }),
            notes: createDatabaseNoteReader(db, "s".repeat(32)),
            capture: createApiCaptureRepository(db),
            ...(enabled
              ? {
                  tasks: createTaskRepository(db),
                  taskBatches: createTaskExtractionRepository(db),
                }
              : {}),
          },
        });
        apps.push(app);
        return app;
      };
      let active = makeApp(true);
      const login = await active.inject({
        method: "POST",
        url: "/auth/dev-session",
        headers: { origin },
        payload: {},
      });
      expect(login.statusCode).toBe(200);
      const headers = {
        origin,
        cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-pce-csrf": login.cookies.find((c) => c.name === "pce_csrf")!.value,
      };
      // The shared typed client uses the real authenticated Fastify routes and DB.
      const request: typeof fetch = async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        const result = await active.inject({
          method: req.method as "GET" | "POST" | "PATCH" | "DELETE",
          url: url.pathname + url.search,
          headers: { ...Object.fromEntries(req.headers), ...headers },
          ...(req.method === "GET" ? {} : { payload: await req.text() }),
        });
        return new Response(result.body, {
          status: result.statusCode,
          headers: { "content-type": "application/json" },
        });
      };
      const client: AuthenticatedRequestOptions = {
        baseUrl: "http://127.0.0.1:3110",
        getAccessToken: () => null,
        useSessionCookie: true,
        getCsrfToken: () => headers["x-pce-csrf"],
        request,
      };
      const original = "Buy filters. Call the dentist. Send the receipt.";
      const markdown = `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: 2026-10-25T10:00:00+01:00
source: chatgpt_text
kind: memo
domains: []
projects: []
tags: []
action_hint: none
review_required: false
title: Synthetic cedarmarker source
---

# Synthetic cedarmarker source

## Summary

Three synthetic commitments.

## Original input

${original}
`;
      const captured = await active.inject({
        method: "POST",
        url: "/api/v1/captures",
        headers,
        payload: { idempotencyKey: captureId, notes: [markdown] },
      });
      expect(captured.json().status).toBe("DB_PERSISTED");
      const before = await db.note.findUniqueOrThrow({ where: { id: noteId } });
      const batch: TaskExtractionBatch = {
        schemaVersion: 1,
        batchId: randomUUID(),
        captureId,
        sourceNoteIds: [noteId],
        classifier: {
          method: "explicit",
          policyVersion: "tasks-v1",
          agent: "synthetic-acceptance",
        },
        tasks: ["Buy filters", "Call the dentist", "Send the receipt"].map(
          (title) => ({
            taskId: randomUUID(),
            title,
            sources: [{ noteId, captureId, evidence: title }],
          }),
        ),
      };
      expect(await saveTaskBatch(client, batch)).toMatchObject({
        status: "DB_PERSISTED",
        replayed: false,
      });
      expect((await getTasks(client)).tasks).toHaveLength(3);
      const id = batch.tasks[0]!.taskId;
      const completed = await changeTask(client, id, {
        commandId: randomUUID(),
        expectedRevision: 1,
        status: "COMPLETED",
      });
      expect(completed.task).toMatchObject({
        status: "COMPLETED",
        revision: 2,
      });
      expect((await getTasks(client)).tasks).toHaveLength(2);
      expect(
        (
          await getTasks(client, { status: "COMPLETED", q: "filters" })
        ).tasks.map((t) => t.taskId),
      ).toEqual([id]);
      expect((await getTasks(client, { status: "ALL" })).tasks).toHaveLength(3);
      expect((await getNote(client, noteId)).originalInput.trim()).toBe(
        original,
      );
      expect(
        (await getTasks(client, { q: "cedarmarker", status: "ALL" })).tasks,
      ).toHaveLength(3);
      await setNoteArchived(client, noteId, true);
      expect(
        (await getTasks(client, { q: "cedarmarker", status: "ALL" })).tasks,
      ).toHaveLength(3);
      expect((await getTask(client, id)).sources).toHaveLength(1);
      await removeNote(client, noteId);
      await expect(getNote(client, noteId)).rejects.toMatchObject({
        status: 404,
      });
      expect(
        (await getTasks(client, { q: "cedarmarker", status: "ALL" })).tasks,
      ).toEqual([]);
      expect(await getTask(client, id)).toMatchObject({
        status: "COMPLETED",
        sources: [],
        unavailableSourceCount: 1,
      });
      const events = await getTaskHistory(client, id);
      expect(events.events.map((e) => e.type)).toEqual([
        "CREATED",
        "COMPLETED",
      ]);

      // Roll back exposure, not durable originals/schema or completion history.
      active = makeApp(false);
      await expect(getTasks(client)).rejects.toMatchObject({ status: 404 });
      expect(await db.task.count({ where: { ownerSubject: owner } })).toBe(3);
      expect(await db.taskEvent.count({ where: { ownerSubject: owner } })).toBe(
        4,
      );
      active = makeApp(true);
      expect(await getTaskHistory(client, id)).toEqual(events);
      expect((await getTask(client, id)).status).toBe("COMPLETED");
      expect(await saveTaskBatch(client, batch)).toMatchObject({
        replayed: true,
      });
      expect((await getTask(client, id)).status).toBe("COMPLETED");
      await changeTask(client, id, {
        commandId: randomUUID(),
        expectedRevision: 2,
        status: "OPEN",
      });
      expect((await getTasks(client)).tasks).toHaveLength(3);
      expect(
        (await getTaskHistory(client, id)).events.map((e) => e.type),
      ).toEqual(["CREATED", "COMPLETED", "REOPENED"]);
      const after = await db.note.findUniqueOrThrow({ where: { id: noteId } });
      expect([after.body, after.originalInput, after.contentHash]).toEqual([
        before.body,
        before.originalInput,
        before.contentHash,
      ]);
      expect(after.removedAt).not.toBeNull();
      expect(await db.note.count({ where: { ownerSubject: owner } })).toBe(1);
    });
  },
);
