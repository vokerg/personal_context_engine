import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createNoteRepository } from "./index.js";
import { createEmbeddingJobRepository } from "./embedding-jobs.js";

const url = process.env.PCE_DB_TEST_URL;
describe.skipIf(!url)("durable embedding queue (synthetic PostgreSQL)", () => {
  let db: PrismaClient;
  const captures: string[] = [];
  const notes: string[] = [];
  function fixture(owner: string) {
    const noteId = randomUUID(), captureId = randomUUID();
    notes.push(noteId); captures.push(captureId);
    const input = {
      sourcePath: `inbox/2026-10-19_${noteId}.md`,
      sourceRevision: "r-" + randomUUID(),
      ownerSubject: owner,
      markdown: `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: 2026-10-19T08:00:00+02:00
source: import
kind: idea
domains: []
projects: []
tags: ["synthetic"]
action_hint: none
review_required: false
title: Synthetic embedding fixture
---

# Synthetic embedding fixture

## Summary

Fake summary.

## Original input

Synthetic original.
`,
    };
    return { input, noteId };
  }
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
  });
  afterAll(async () => {
    if (!db) return;
    await db.note.deleteMany({ where: { id: { in: notes } } });
    await db.capture.deleteMany({ where: { id: { in: captures } } });
    await db.$disconnect();
  });

  it("queues owner-scoped chunks, leases once, stores a 1536-vector with usage, and preserves replay", async () => {
    const { input, noteId } = fixture("embed-owner-1");
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    expect((await repo.prepareNote(noteId, "foreign-owner")).status).toBe("missing");
    const queued = await repo.prepareNote(noteId, input.ownerSubject);
    expect(queued.count).toBeGreaterThan(0);
    expect((await repo.prepareNote(noteId, input.ownerSubject)).status).toBe("unchanged");
    expect(await repo.candidateNotes(input.ownerSubject)).not.toContain(noteId);
    const now = new Date();
    expect(await repo.claim("foreign-owner", "worker-1", now)).toBeNull();
    const job = await repo.claim(input.ownerSubject, "worker-1", now);
    expect(job).not.toBeNull();
    expect(await repo.claim(input.ownerSubject, "worker-2", now)).not.toMatchObject({ id: job!.id });
    await expect(repo.complete(input.ownerSubject, "worker-1", job!.id, [1], 12, now))
      .rejects.toThrow("Invalid embedding dimensions");
    const vector = Array<number>(1536).fill(0); vector[0] = 1;
    expect(await repo.complete("foreign-owner", "worker-1", job!.id, vector, 12, now)).toBe(false);
    expect(await repo.complete(input.ownerSubject, "worker-1", job!.id, vector, 12, now)).toBe(true);
    expect(await repo.complete(input.ownerSubject, "worker-1", job!.id, vector, 12, now)).toBe(false);
    const rows = await db.$queryRaw<Array<{ dimensions: number; tokens: number; nano: bigint }>>`
      SELECT vector_dims("vector") AS dimensions, "usageTokens" AS tokens,
             "estimatedCostNanoUsd" AS nano
      FROM "chunk_embeddings" WHERE "id" = ${job!.id}
    `;
    expect(rows).toEqual([{ dimensions: 1536, tokens: 12, nano: 240n }]);
    const replayCount = await db.chunkEmbedding.count({
      where: { chunk: { noteId, ownerSubject: input.ownerSubject } },
    });
    await repo.prepareNote(noteId, input.ownerSubject);
    expect(await db.chunkEmbedding.count({
      where: { chunk: { noteId, ownerSubject: input.ownerSubject } },
    })).toBe(replayCount);
  });

  it("drops stale leased jobs after source revision change and retries transient errors", async () => {
    const { input, noteId } = fixture("embed-owner-2");
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    await repo.prepareNote(noteId, input.ownerSubject);
    const now = new Date();
    const job = await repo.claim(input.ownerSubject, "worker-1", now);
    expect(job).not.toBeNull();
    expect(await repo.fail(input.ownerSubject, "worker-1", job!.id, "RATE_LIMIT", true, 1, now)).toBe(true);
    const row = await db.chunkEmbedding.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe("RETRY");
    expect(row.nextRetryAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await repo.claim(input.ownerSubject, "worker-2", now)).not.toMatchObject({ id: job!.id });
    const later = new Date(row.nextRetryAt!.getTime() + 1);
    const recovered = await repo.claim(input.ownerSubject, "worker-3", later);
    expect(recovered?.id).toBe(job!.id);
    await createNoteRepository(db).importMarkdown({
      ...input,
      sourceRevision: "r-" + randomUUID(),
      expectedPreviousRevision: input.sourceRevision,
      markdown: input.markdown.replace("Fake summary.", "Changed fake summary."),
    });
    const vector = Array<number>(1536).fill(0);
    expect(await repo.complete(input.ownerSubject, "worker-3", job!.id, vector, 1, later)).toBe(false);
    expect(await db.chunkEmbedding.findUnique({ where: { id: job!.id } })).toBeNull();
    expect((await repo.prepareNote(noteId, input.ownerSubject)).status).toBe("synchronized");
  });

  it("recovers expired leases with keyset scans without cross-tenant claiming", async () => {
    const { input, noteId } = fixture("embed-owner-3");
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    expect(await repo.candidateNotes("embed-owner-3")).toContain(noteId);
    await repo.prepareNote(noteId, input.ownerSubject);
    const t = new Date();
    const leased = await repo.claim(input.ownerSubject, "worker-old", t);
    expect(leased).not.toBeNull();
    const future = new Date(t.getTime() + 120_001);
    const reLeased = await repo.claim(input.ownerSubject, "worker-new", future);
    expect(reLeased?.id).toBe(leased!.id);
    expect(reLeased?.attemptCount).toBe(2);
    expect(await repo.fail(input.ownerSubject, "worker-old", leased!.id, "PROVIDER_5XX", true, 1, future)).toBe(false);
  });
});
