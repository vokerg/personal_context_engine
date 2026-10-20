import { createApp } from "../../../apps/api/src/app.js";
import { createSessionAuth } from "../../../apps/api/src/session-auth.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  createApiCaptureRepository,
  createNoteRepository,
} from "./index.js";
import { runDbJobPass } from "../../../apps/worker/src/db-jobs.js";
const url = process.env.PCE_DB_TEST_URL;
export function captureFixture() {
  const id = randomUUID(),
    capture = randomUUID();
  return {
    id,
    capture,
    markdown: `---
schema_version: 1
id: ${id}
capture_id: ${capture}
captured_at: 2026-10-20T09:00:00+02:00
source: chatgpt_text
kind: memo
domains: []
projects: [synthetic]
tags: [finance]
action_hint: none
review_required: false
title: Synthetic invoice
---

# Synthetic invoice

## Summary

Synthetic summary.

## Original input

закрыть инвойс
`,
  };
}
describe.skipIf(!url)("durable API-only capture", () => {
  let db: PrismaClient;
  const owner = "capture-" + randomUUID(),
    ids: string[] = [],
    captures: string[] = [];
  const fixture = () => {
    const f = captureFixture();
    ids.push(f.id);
    captures.push(f.capture);
    return f;
  };
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
  });
  afterAll(async () => {
    if (db) {
      await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
      await db.note.deleteMany({ where: { id: { in: ids } } });
      await db.capture.deleteMany({ where: { id: { in: captures } } });
      await db.$disconnect();
    }
  });
  it("commits originals and jobs exactly once under concurrent retries with no GitHub/provider", async () => {
    const f = fixture(),
      repo = createApiCaptureRepository(db),
      input = { idempotencyKey: "same-request", notes: [f.markdown] };
    const replies = await Promise.all([
      repo.persistByOwner(owner, input),
      repo.persistByOwner(owner, input),
    ]);
    expect(replies.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(replies[0]).toMatchObject({
      status: "DB_PERSISTED",
      noteIds: [f.id],
    });
    expect(
      await db.dbProcessingJob.count({
        where: { ownerSubject: owner, noteId: f.id },
      }),
    ).toBe(1);
    const receipt = await db.apiCaptureReceipt.findFirstOrThrow({
      where: { ownerSubject: owner },
    });
    expect(receipt.markdowns).toEqual([f.markdown]);
    const original = await db.note.findUniqueOrThrow({ where: { id: f.id } });
    expect(original.originalInput).toContain("закрыть инвойс");
    expect(original.sourcePath).toBe(`api/${f.id}`);
    const report = await runDbJobPass(db, owner);
    expect(report.prepared).toBe(1);
    expect((await runDbJobPass(db, owner)).prepared).toBe(0);
    expect(
      await db.chunkEmbedding.count({ where: { chunk: { noteId: f.id } } }),
    ).toBeGreaterThan(0);
    await expect(
      repo.persistByOwner(owner, {
        ...input,
        notes: [f.markdown.replace("Synthetic summary.", "Changed.")],
      }),
    ).rejects.toThrow("Capture conflict");
    await expect(
      repo.persistByOwner("foreign-owner", {
        idempotencyKey: "foreign",
        notes: [f.markdown],
      }),
    ).rejects.toThrow("Capture conflict");
  });
  it("rolls back an entire split capture on a conflicting later note", async () => {
    const existing = fixture(),
      first = fixture(),
      repo = createApiCaptureRepository(db);
    await repo.persistByOwner(owner, {
      idempotencyKey: "existing",
      notes: [existing.markdown],
    });
    await expect(
      repo.persistByOwner(owner, {
        idempotencyKey: "atomic",
        notes: [
          first.markdown,
          existing.markdown.replace("Synthetic summary.", "Conflicting."),
        ],
      }),
    ).rejects.toThrow();
    expect(await db.note.findUnique({ where: { id: first.id } })).toBeNull();
    expect(
      await db.capture.findUnique({ where: { id: first.capture } }),
    ).toBeNull();
    expect(
      await db.dbProcessingJob.count({ where: { noteId: first.id } }),
    ).toBe(0);
  });
  it("never guesses capture ownership or creates an echo to a GitHub import", async () => {
    const f = fixture(),
      repo = createApiCaptureRepository(db);
    await createNoteRepository(db).importMarkdown({
      ownerSubject: owner,
      sourcePath: `inbox/2026-10-20_${f.id}.md`,
      sourceRevision: "synthetic-revision",
      markdown: f.markdown,
    });
    const same = await repo.persistByOwner(owner, {
      idempotencyKey: "same-source",
      notes: [f.markdown],
    });
    expect(same.noteIds).toEqual([f.id]);
    expect(
      (await db.note.findUniqueOrThrow({ where: { id: f.id } })).sourcePath,
    ).toMatch(/^inbox/);
    const foreign = fixture();
    await expect(
      createNoteRepository(db).importMarkdown({
        ownerSubject: "foreign",
        sourcePath: `inbox/2026-10-20_${foreign.id}.md`,
        sourceRevision: "foreign-revision",
        markdown: foreign.markdown.replace(foreign.capture, f.capture),
      }),
    ).rejects.toMatchObject({ code: "OWNER_CONFLICT" });
  });
  it("requires capture scope and rejects client-selected ownership", async () => {
    const f = fixture(),
      origin = "http://127.0.0.1:4310";
    const auth = createSessionAuth(db, {
      mode: "dev-single-user",
      ownerSubject: owner,
      origin,
      issuer: "http://127.0.0.1:3110",
      audience: "http://127.0.0.1:3110/mcp",
      secure: false,
    });
    const app = createApp({
      config: {
        host: "127.0.0.1",
        port: 3110,
        environment: "test",
        corsOrigin: origin,
        requiresDatabase: false,
        auth: null,
      },
      dependencies: {
        sessionAuth: auth,
        capture: createApiCaptureRepository(db),
      },
    });
    try {
      const input = { idempotencyKey: "http-test", notes: [f.markdown] };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/captures",
            payload: input,
          })
        ).statusCode,
      ).toBe(401);
      const login = await app.inject({
        method: "POST",
        url: "/auth/dev-session",
        headers: { origin },
        payload: {},
      });
      const cookie = login.cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; "),
        csrf = login.cookies.find((c) => c.name === "pce_csrf")!.value;
      const headers = { origin, cookie, "x-pce-csrf": csrf };
      const read = await app.inject({
        method: "POST",
        url: "/auth/token",
        headers,
        payload: { scope: "notes:read" },
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/captures",
            headers: { authorization: "Bearer " + read.json().access_token },
            payload: input,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/captures",
            headers,
            payload: { ...input, ownerSubject: "forged" },
          })
        ).statusCode,
      ).toBe(400);
      const saved = await app.inject({
        method: "POST",
        url: "/api/v1/captures",
        headers,
        payload: input,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().status).toBe("DB_PERSISTED");
      expect(
        (await db.note.findUniqueOrThrow({ where: { id: f.id } })).ownerSubject,
      ).toBe(owner);
    } finally {
      await app.close();
      await db.authSession.deleteMany({ where: { ownerSubject: owner } });
    }
  });
});
