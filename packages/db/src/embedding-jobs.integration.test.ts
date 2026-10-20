import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createLexicalSearchRepository } from "./lexical-search.js";
import {
  runEmbeddingPass,
  EmbeddingProviderError,
} from "../../../apps/worker/src/embeddings.js";
import { createNoteRepository } from "./index.js";
import { createEmbeddingJobRepository } from "./embedding-jobs.js";

const url = process.env.PCE_DB_TEST_URL;
describe.skipIf(!url)("durable embedding queue (synthetic PostgreSQL)", () => {
  let db: PrismaClient;
  const captures: string[] = [];
  const owners: string[] = ["foreign-owner"];
  const notes: string[] = [];
  function fixture(owner: string) {
    owners.push(owner);
    const noteId = randomUUID(),
      captureId = randomUUID();
    notes.push(noteId);
    captures.push(captureId);
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
    await db.embeddingDailyBudget.deleteMany({
      where: { ownerSubject: { in: owners } },
    });
    await db.embeddingScan.deleteMany({
      where: { ownerSubject: { in: owners } },
    });
    await db.$disconnect();
  });

  it("queues owner-scoped chunks, leases once, stores a 1536-vector with usage, and preserves replay", async () => {
    const { input, noteId } = fixture("embed-owner-1");
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    expect((await repo.prepareNote(noteId, "foreign-owner")).status).toBe(
      "missing",
    );
    const queued = await repo.prepareNote(noteId, input.ownerSubject);
    expect(queued.count).toBeGreaterThan(0);
    expect((await repo.prepareNote(noteId, input.ownerSubject)).status).toBe(
      "unchanged",
    );
    expect(await repo.candidateNotes(input.ownerSubject)).not.toContain(noteId);
    const now = new Date();
    expect(await repo.claim("foreign-owner", "worker-1", now)).toBeNull();
    const job = await repo.claim(input.ownerSubject, "worker-1", now);
    expect(job).not.toBeNull();
    expect(
      await repo.claim(input.ownerSubject, "worker-2", now),
    ).not.toMatchObject({ id: job!.id });
    await expect(
      repo.complete(input.ownerSubject, "worker-1", job!.id, [1], 12, now),
    ).rejects.toThrow("Invalid embedding dimensions");
    const vector = Array<number>(1536).fill(0);
    vector[0] = 1;
    expect(
      await repo.complete(
        "foreign-owner",
        "worker-1",
        job!.id,
        vector,
        12,
        now,
      ),
    ).toBe(false);
    expect(
      await repo.complete(
        input.ownerSubject,
        "worker-1",
        job!.id,
        vector,
        12,
        now,
      ),
    ).toBe(true);
    expect(
      await repo.complete(
        input.ownerSubject,
        "worker-1",
        job!.id,
        vector,
        12,
        now,
      ),
    ).toBe(false);
    const rows = await db.$queryRaw<
      Array<{ dimensions: number; tokens: number; nano: bigint }>
    >`
      SELECT vector_dims("vector") AS dimensions, "usageTokens" AS tokens,
             "estimatedCostNanoUsd" AS nano
      FROM "chunk_embeddings" WHERE "id" = ${job!.id}
    `;
    expect(rows).toEqual([{ dimensions: 1536, tokens: 12, nano: 240n }]);
    const replayCount = await db.chunkEmbedding.count({
      where: { chunk: { noteId, ownerSubject: input.ownerSubject } },
    });
    await repo.prepareNote(noteId, input.ownerSubject);
    expect(
      await db.chunkEmbedding.count({
        where: { chunk: { noteId, ownerSubject: input.ownerSubject } },
      }),
    ).toBe(replayCount);
  });

  it("drops stale leased jobs after source revision change and retries transient errors", async () => {
    const { input, noteId } = fixture("embed-owner-2");
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    await repo.prepareNote(noteId, input.ownerSubject);
    const now = new Date();
    const job = await repo.claim(input.ownerSubject, "worker-1", now);
    expect(job).not.toBeNull();
    expect(
      await repo.fail(
        input.ownerSubject,
        "worker-1",
        job!.id,
        "RATE_LIMIT",
        true,
        1,
        now,
      ),
    ).toBe(true);
    const row = await db.chunkEmbedding.findUniqueOrThrow({
      where: { id: job!.id },
    });
    expect(row.status).toBe("RETRY");
    expect(row.nextRetryAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(
      await repo.claim(input.ownerSubject, "worker-2", now),
    ).not.toMatchObject({ id: job!.id });
    const later = new Date(row.nextRetryAt!.getTime() + 1);
    const recovered = await repo.claim(input.ownerSubject, "worker-3", later);
    expect(recovered?.id).toBe(job!.id);
    await createNoteRepository(db).importMarkdown({
      ...input,
      sourceRevision: "r-" + randomUUID(),
      expectedPreviousRevision: input.sourceRevision,
      markdown: input.markdown.replace(
        "Fake summary.",
        "Changed fake summary.",
      ),
    });
    const vector = Array<number>(1536).fill(0);
    expect(
      await repo.complete(
        input.ownerSubject,
        "worker-3",
        job!.id,
        vector,
        1,
        later,
      ),
    ).toBe(false);
    expect(
      await db.chunkEmbedding.findUnique({ where: { id: job!.id } }),
    ).toBeNull();
    expect((await repo.prepareNote(noteId, input.ownerSubject)).status).toBe(
      "synchronized",
    );
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
    expect(
      await repo.fail(
        input.ownerSubject,
        "worker-old",
        leased!.id,
        "PROVIDER_5XX",
        true,
        1,
        future,
      ),
    ).toBe(false);
  });
  it("atomically limits concurrent requests, keeps failed/deleted reservations, and resets at UTC midnight", async () => {
    const { input, noteId } = fixture("embed-budget-" + randomUUID());
    input.markdown = input.markdown.replace(
      "Synthetic original.",
      "synthetic ".repeat(6000),
    );
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    await repo.prepareNote(noteId, input.ownerSubject);
    const now = new Date("2026-10-20T09:00:00Z");
    const jobs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repo.claim(input.ownerSubject, `worker-${i}`, now),
      ),
    );
    expect(jobs.filter(Boolean)).toHaveLength(4);
    expect(new Set(jobs.filter(Boolean).map((j) => j!.id)).size).toBe(4);
    expect(
      await repo.reservedTokensToday(input.ownerSubject, now),
    ).toBeGreaterThan(0);
    const job = jobs.find(Boolean)!;
    const lease = await db.chunkEmbedding.findUniqueOrThrow({
      where: { id: job.id },
    });
    await repo.fail(
      input.ownerSubject,
      lease.leaseOwner!,
      job.id,
      "PROVIDER_5XX",
      true,
      job.attemptCount,
      now,
    );
    const later = new Date(now.getTime() + 60_000);
    const next = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        repo.claim(input.ownerSubject, `next-${i}`, later),
      ),
    );
    expect(next.filter(Boolean)).toHaveLength(4);
    await db.embeddingDailyBudget.updateMany({
      where: { ownerSubject: input.ownerSubject },
      data: { reservedTokens: 60000 },
    });
    expect(await repo.reservedTokensToday(input.ownerSubject, later)).toBe(
      60000,
    );
    expect(
      await repo.claim(
        input.ownerSubject,
        "blocked",
        new Date(now.getTime() + 300_000),
      ),
    ).toBeNull();
    await createNoteRepository(db).importMarkdown({
      ...input,
      sourceRevision: "new-" + randomUUID(),
      expectedPreviousRevision: input.sourceRevision,
      markdown: input.markdown.replace(
        "Fake summary.",
        "Updated synthetic summary.",
      ),
    });
    expect(
      await db.chunkEmbedding.count({ where: { chunk: { noteId } } }),
    ).toBe(0);
    // Deleting all charged chunks does not buy more requests.
    expect(await repo.reservedTokensToday(input.ownerSubject, later)).toBe(
      60000,
    );
    await repo.prepareNote(noteId, input.ownerSubject);
    expect(
      await repo.claim(input.ownerSubject, "still-blocked", later),
    ).toBeNull();
    const midnight = new Date("2026-10-21T00:00:00Z");
    expect(
      await repo.claim(input.ownerSubject, "tomorrow", midnight),
    ).not.toBeNull();
    expect(
      await repo.reservedTokensToday(input.ownerSubject, midnight),
    ).toBeGreaterThan(0);
    expect(await repo.reservedTokensToday("other-owner", midnight)).toBe(0);
  });

  it("persists preparation progress and wraps after the last page", async () => {
    const { input, noteId } = fixture("embed-scan-" + randomUUID());
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    await repo.checkpointScan(input.ownerSubject, noteId);
    // A fresh repository resumes; no provider or preparation is required to recover the cursor.
    const restarted = createEmbeddingJobRepository(db);
    expect(await restarted.candidateNotes(input.ownerSubject)).not.toContain(
      noteId,
    );
    await restarted.checkpointScan(input.ownerSubject, null);
    expect(await restarted.candidateNotes(input.ownerSubject)).toContain(
      noteId,
    );
  });

  it("runs fake provider retries/restart end to end and keeps DB-only lexical retrieval available", async () => {
    const { input, noteId } = fixture("embed-fallback-" + randomUUID());
    const foreign = fixture("embed-foreign-" + randomUUID());
    await createNoteRepository(db).importMarkdown(input);
    await createNoteRepository(db).importMarkdown(foreign.input);
    // Synthetic DB-only ingress; no GitHub file, snapshot allowlist or index.
    await db.note.update({ where: { id: noteId }, data: { source: "api" } });
    const now = new Date("2026-10-22T09:00:00Z");
    const failed = await runEmbeddingPass({
      queue: createEmbeddingJobRepository(db),
      ownerSubject: input.ownerSubject,
      now: () => now,
      provider: {
        embed: async () => {
          throw new EmbeddingProviderError("RATE_LIMIT", true);
        },
      },
    });
    expect(failed.retry).toBeGreaterThan(0);
    expect(failed.ready).toBe(0);
    const search = createLexicalSearchRepository(db);
    expect(
      await search.searchByOwner(input.ownerSubject, "Synthetic original"),
    ).toMatchObject([{ id: noteId, source: "api" }]);
    expect(
      await search.searchByOwner("unrelated-owner", "Synthetic original"),
    ).toEqual([]);
    expect(
      await search.searchByOwner(input.ownerSubject, "' OR true --"),
    ).toEqual([]);
    await expect(
      search.searchByOwner(input.ownerSubject, "x", 1000),
    ).rejects.toThrow();
    const recovered = await runEmbeddingPass({
      queue: createEmbeddingJobRepository(db),
      ownerSubject: input.ownerSubject,
      now: () => new Date(now.getTime() + 60_001),
      provider: {
        embed: async () => ({
          vector: Array<number>(1536).fill(0.125),
          usageTokens: 5,
        }),
      },
    });
    expect(recovered.ready).toBeGreaterThan(0);
    const replay = await runEmbeddingPass({
      queue: createEmbeddingJobRepository(db),
      ownerSubject: input.ownerSubject,
      now: () => new Date(now.getTime() + 60_002),
      provider: {
        embed: async () => {
          throw new Error("Replay must not call provider");
        },
      },
    });
    expect(replay.requests).toBe(0);
    expect(await db.note.findUnique({ where: { id: noteId } })).not.toBeNull();
  });
  it("terminally fails the final expired lease and preserves the note", async () => {
    const { input, noteId } = fixture("embed-terminal-" + randomUUID());
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    await repo.prepareNote(noteId, input.ownerSubject);
    const now = new Date();
    const job = await repo.claim(input.ownerSubject, "crashed", now);
    await db.chunkEmbedding.update({
      where: { id: job!.id },
      data: {
        attemptCount: 6,
        leaseUntil: new Date(now.getTime() - 1),
      },
    });
    await repo.claim(input.ownerSubject, "restart", now);
    expect(
      await db.chunkEmbedding.findUnique({ where: { id: job!.id } }),
    ).toMatchObject({
      status: "FAILED",
      lastErrorCode: "LEASE_EXHAUSTED",
      leaseOwner: null,
    });
    expect(await db.note.findUnique({ where: { id: noteId } })).not.toBeNull();
  });
  it("keeps the owner rate window across UTC midnight", async () => {
    const { input, noteId } = fixture("embed-midnight-" + randomUUID());
    input.markdown = input.markdown.replace(
      "Synthetic original.",
      "synthetic ".repeat(2000),
    );
    await createNoteRepository(db).importMarkdown(input);
    const repo = createEmbeddingJobRepository(db);
    await repo.prepareNote(noteId, input.ownerSubject);
    const now = new Date("2026-10-23T23:59:59Z");
    for (let i = 0; i < 4; i++)
      expect(
        await repo.claim(input.ownerSubject, `before-${i}`, now),
      ).not.toBeNull();
    expect(
      await repo.claim(
        input.ownerSubject,
        "after",
        new Date("2026-10-24T00:00:00Z"),
      ),
    ).toBeNull();
    expect(
      await repo.claim(
        input.ownerSubject,
        "after-window",
        new Date("2026-10-24T00:00:59Z"),
      ),
    ).not.toBeNull();
  });
});
