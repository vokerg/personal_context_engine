import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, createApiCaptureRepository, createNoteTagRepository } from "@pce/db";
import { createApp } from "./app.js";
import { createDatabaseNoteReader } from "./database-reader.js";
import { createSessionAuth, type SessionConfig } from "./session-auth.js";

const url = process.env.PCE_DB_TEST_URL;
const owner = "tag-http-" + randomUUID();
const foreign = "tag-http-other-" + randomUUID();
const noteId = randomUUID(), foreignId = randomUUID();
const capture = randomUUID(), foreignCapture = randomUUID();
const config: SessionConfig = {
  mode: "dev-single-user",
  ownerSubject: owner,
  origin: "http://127.0.0.1:4310",
  issuer: "http://127.0.0.1:3110",
  audience: "http://127.0.0.1:3110/mcp",
  secure: false,
};
const markdown = (id: string, captureId: string) => `---
schema_version: 1
id: ${id}
capture_id: ${captureId}
captured_at: 2026-10-22T19:00:00+02:00
source: chatgpt_text
kind: memo
domains: []
projects: []
tags: [old-tag]
action_hint: none
review_required: false
title: Synthetic note tag API
---

# Synthetic note tag API

## Summary

Synthetic text.

## Original input

Synthetic text.
`;

describe.skipIf(!url)("manual tag API authorization and concurrency", () => {
  let db: PrismaClient;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
    const captures = createApiCaptureRepository(db);
    await captures.persistByOwner(owner, { idempotencyKey: "synthetic-tag-http", notes: [markdown(noteId, capture)] });
    await captures.persistByOwner(foreign, { idempotencyKey: "synthetic-tag-http", notes: [markdown(foreignId, foreignCapture)] });
  });
  afterAll(async () => {
    if (!db) return;
    await db.authSession.deleteMany({ where: { ownerSubject: owner } });
    await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: { in: [owner, foreign] } } });
    await db.note.deleteMany({ where: { id: { in: [noteId, foreignId] } } });
    await db.capture.deleteMany({ where: { id: { in: [capture, foreignCapture] } } });
    await db.$disconnect();
  });
  it("requires tags:write, protects cookies, refuses unowned IDs and rejects stale revisions", async () => {
    const app = createApp({
      config: {
        host: "127.0.0.1", port: 3110, environment: "test",
        corsOrigin: config.origin, requiresDatabase: false, auth: null,
      },
      dependencies: {
        sessionAuth: createSessionAuth(db, config),
        notes: createDatabaseNoteReader(db, "tag-http-cursor-secret-".repeat(3)),
        noteTagEdits: createNoteTagRepository(db),
      },
    });
    const route = `/api/v1/notes/${noteId}/tags`;
    try {
      expect((await app.inject({ method: "PATCH", url: route, payload: {
        operation: "add", slug: "new-tag", expectedRevision: 0,
      } })).statusCode).toBe(401);
      const login = await app.inject({ method: "POST", url: "/auth/dev-session", headers: { origin: config.origin }, payload: {} });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const csrf = login.cookies.find((c) => c.name === "pce_csrf")!.value;
      const grant = async (scope: string) => {
        const response = await app.inject({
          method: "POST", url: "/auth/token",
          headers: { origin: config.origin, cookie, "x-pce-csrf": csrf },
          payload: { scope },
        });
        expect(response.statusCode).toBe(200);
        return response.json().access_token as string;
      };
      const readToken = await grant("notes:read");
      const writeToken = await grant("tags:write");
      const edit = { operation: "add", slug: "new-tag", expectedRevision: 0 };
      expect((await app.inject({ method: "PATCH", url: route, headers: { authorization: "Bearer " + readToken }, payload: edit })).statusCode).toBe(403);
      expect((await app.inject({ method: "PATCH", url: route, headers: { cookie, origin: config.origin }, payload: edit })).statusCode).toBe(403);
      expect((await app.inject({ method: "PATCH", url: route, headers: { cookie, origin: "https://invalid.example", "x-pce-csrf": csrf }, payload: edit })).statusCode).toBe(403);
      expect((await app.inject({ method: "PATCH", url: `/api/v1/notes/${foreignId}/tags`, headers: { authorization: "Bearer " + writeToken }, payload: edit })).statusCode).toBe(404);
      for (const payload of [
        { ...edit, ownerSubject: foreign },
        { ...edit, slug: "../invalid" },
        { ...edit, expectedRevision: -1 },
        { ...edit, operation: "approve" },
      ]) {
        const res = await app.inject({ method: "PATCH", url: route, headers: { authorization: "Bearer " + writeToken }, payload });
        expect(res.statusCode).toBe(400);
      }
      const changed = await app.inject({ method: "PATCH", url: route, headers: { authorization: "Bearer " + writeToken }, payload: edit });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({
        tags: ["new-tag", "old-tag"], changed: true,
        tagEditing: { sourceTags: ["old-tag"], manualAdded: ["new-tag"], revision: 1 },
      });
      const conflict = await app.inject({ method: "PATCH", url: route, headers: { authorization: "Bearer " + writeToken }, payload: edit });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ error: { code: "CONFLICT" } });
      const detail = await app.inject({ url: `/api/v1/notes/${noteId}`, headers: { authorization: "Bearer " + readToken } });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ tags: ["new-tag", "old-tag"], tagEditing: { revision: 1 } });
      const cookieWrite = await app.inject({ method: "PATCH", url: route, headers: { cookie, origin: config.origin, "x-pce-csrf": csrf }, payload: { operation: "remove", slug: "old-tag", expectedRevision: 1 } });
      expect(cookieWrite.statusCode).toBe(200);
      expect(cookieWrite.json()).toMatchObject({ tags: ["new-tag"], tagEditing: { revision: 2, manualRemoved: ["old-tag"] } });
    } finally {
      await app.close();
    }
  });
});
