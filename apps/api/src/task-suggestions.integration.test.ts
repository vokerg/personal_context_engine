import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  createApiCaptureRepository,
  createTaskRepository,
  createTaskExtractionRepository,
} from "@pce/db";
import {
  suggestTasksForNote,
  saveSuggestedTasks,
  changeTask,
  type AuthenticatedRequestOptions,
} from "@pce/api-client";
import { createApp } from "./app.js";
import { createSessionAuth } from "./session-auth.js";

describe.skipIf(!process.env.PCE_DB_TEST_URL)(
  "Note postprocessing with real PostgreSQL and typed HTTP",
  () => {
    let db: PrismaClient;
    let app: ReturnType<typeof createApp>;
    const owner = "suggestion-test-" + randomUUID();
    const noteId = randomUUID(),
      captureId = randomUUID();
    const original =
      "Repair the search form; add keyboard navigation; fix pagination; investigate slow imports; add import cursor.";
    const titles = original.slice(0, -1).split("; ");
    afterAll(async () => {
      if (app) await app.close();
      if (!db) return;
      await db.taskExtractionBatch.deleteMany({
        where: { ownerSubject: owner },
      });
      await db.taskSource.deleteMany({ where: { ownerSubject: owner } });
      await db.taskCommand.deleteMany({ where: { ownerSubject: owner } });
      await db.taskEvent.deleteMany({ where: { ownerSubject: owner } });
      await db.task.deleteMany({ where: { ownerSubject: owner } });
      await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
      await db.dbProcessingJob.deleteMany({ where: { ownerSubject: owner } });
      await db.note.deleteMany({ where: { ownerSubject: owner } });
      await db.capture.deleteMany({ where: { id: captureId } });
      await db.authSession.deleteMany({ where: { ownerSubject: owner } });
      await db.$disconnect();
    });
    it("adds five tasks after an existing zero-task batch, rolls back partial failures, and safely replays after completion/removal", async () => {
      db = new PrismaClient({
        datasources: { db: { url: process.env.PCE_DB_TEST_URL! } },
      });
      await db.$connect();
      const origin = "http://127.0.0.1:4310",
        issuer = "http://127.0.0.1:3110";
      const tasks = createTaskRepository(db),
        batches = createTaskExtractionRepository(db);
      let providerCalls = 0;
      app = createApp({
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
            issuer,
            audience: issuer + "/mcp",
            secure: false,
          }),
          tasks,
          taskBatches: batches,
          capture: createApiCaptureRepository(db),
          taskSuggestions: {
            provider: {
              model: "synthetic",
              suggest: async () => {
                providerCalls++;
                return {
                  tasks: titles.map((title) => ({
                    taskId: randomUUID(),
                    title,
                    evidence: title,
                  })),
                  reason: "",
                };
              },
            },
            getSource: (subject, id) =>
              db.note.findFirst({
                where: { id, ownerSubject: subject, removedAt: null },
                select: { captureId: true, originalInput: true },
              }),
          },
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/auth/dev-session",
        headers: { origin },
        payload: {},
      });
      const headers = {
        origin,
        cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        "x-pce-csrf": login.cookies.find((c) => c.name === "pce_csrf")!.value,
      };
      const client: AuthenticatedRequestOptions = {
        baseUrl: issuer,
        getAccessToken: () => null,
        useSessionCookie: true,
        getCsrfToken: () => headers["x-pce-csrf"],
        request: async (url, init) => {
          const req = new Request(url, init);
          const result = await app.inject({
            method: req.method as "GET" | "POST" | "PATCH",
            url: new URL(req.url).pathname,
            headers: { ...Object.fromEntries(req.headers), ...headers },
            ...(req.method === "GET" ? {} : { payload: await req.text() }),
          });
          return new Response(result.body, {
            status: result.statusCode,
            headers: { "Content-Type": "application/json" },
          });
        },
      };
      const markdown = `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: 2026-11-07T10:00:00+01:00
source: chatgpt_text
kind: memo
domains: []
projects: []
tags: []
action_hint: none
review_required: false
title: Synthetic task postprocessing
---

# Synthetic task postprocessing

## Summary

Five synthetic actions.

## Original input

${original}
`;
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/captures",
            headers,
            payload: { idempotencyKey: captureId, notes: [markdown] },
          })
        ).json().status,
      ).toBe("DB_PERSISTED");
      await batches.persistByOwner(owner, {
        schemaVersion: 1,
        batchId: randomUUID(),
        captureId,
        sourceNoteIds: [noteId],
        classifier: {
          method: "explicit",
          policyVersion: "tasks-v1",
          agent: "synthetic",
        },
        tasks: [],
        zeroTasksReason: "Not extracted during capture.",
      });
      const before = await db.note.findUniqueOrThrow({ where: { id: noteId } });
      const draft = await suggestTasksForNote(client, noteId);
      expect(draft.tasks).toHaveLength(5);
      const input = { captureId: draft.captureId, tasks: draft.tasks };
      const malformed = {
        ...input,
        tasks: draft.tasks.map((t, i) =>
          i === 4 ? { ...t, evidence: "Absent original quote" } : t,
        ),
      };
      await expect(
        saveSuggestedTasks(client, noteId, malformed),
      ).rejects.toMatchObject({ status: 400 });
      expect(await db.task.count({ where: { ownerSubject: owner } })).toBe(0);
      const saved = await saveSuggestedTasks(client, noteId, input);
      expect(saved.receipts).toHaveLength(5);
      expect(
        saved.receipts.every(
          (r) => !r.replayed && r.task.sources[0]?.noteId === noteId,
        ),
      ).toBe(true);
      await changeTask(client, draft.tasks[0]!.taskId, {
        commandId: randomUUID(),
        expectedRevision: 1,
        status: "COMPLETED",
      });
      const replay = await saveSuggestedTasks(client, noteId, input);
      expect(replay.receipts.every((r) => r.replayed)).toBe(true);
      expect(replay.receipts[0]!.task.status).toBe("COMPLETED");
      expect(await db.taskEvent.count({ where: { ownerSubject: owner } })).toBe(
        6,
      );
      const after = await db.note.findUniqueOrThrow({ where: { id: noteId } });
      expect([after.body, after.originalInput, after.contentHash]).toEqual([
        before.body,
        before.originalInput,
        before.contentHash,
      ]);
      await db.note.update({
        where: { id: noteId },
        data: { removedAt: new Date() },
      });
      expect(
        (await saveSuggestedTasks(client, noteId, input)).receipts.every(
          (r) => r.replayed,
        ),
      ).toBe(true);
      await expect(
        saveSuggestedTasks(client, noteId, {
          ...input,
          tasks: input.tasks.map((t) => ({ ...t, taskId: randomUUID() })),
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(await db.task.count({ where: { ownerSubject: owner } })).toBe(5);
      expect(providerCalls).toBe(1);
    });
  },
);
