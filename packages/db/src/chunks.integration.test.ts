import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createNoteRepository } from "./index.js";
import { createNoteChunkRepository } from "./chunks.js";

const url = process.env.PCE_DB_TEST_URL;

describe.skipIf(!url)(
  "pgvector provenance and owner boundaries (synthetic DB)",
  () => {
    let client: PrismaClient;
    const notes: string[] = [];
    const captures: string[] = [];

    function sample() {
      const noteId = randomUUID();
      const captureId = randomUUID();
      notes.push(noteId);
      captures.push(captureId);
      return {
        noteId,
        captureId,
        sourcePath: `inbox/2026-10-15_${noteId}.md`,
        sourceRevision: "r-" + randomUUID(),
        markdown: `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: 2026-10-15T08:30:00+02:00
source: import
kind: idea
domains: []
projects: []
tags: ["synthetic"]
action_hint: none
review_required: false
title: Synthetic vector fixture
---

# Synthetic vector fixture

## Summary

Synthetic summary.

## Original input

Synthetic original 😀.
`,
      };
    }

    beforeAll(async () => {
      client = new PrismaClient({ datasources: { db: { url: url! } } });
      await client.$connect();
    });

    afterAll(async () => {
      if (!client) return;
      await client.note.deleteMany({ where: { id: { in: notes } } });
      await client.capture.deleteMany({ where: { id: { in: captures } } });
      await client.$disconnect();
    });

    it("preserves READY vectors on replay but destroys them on source revision change", async () => {
      const input = sample();
      const notesRepo = createNoteRepository(client);
      const chunks = createNoteChunkRepository(client);
      await notesRepo.importMarkdown({
        ...input,
        ownerSubject: "chunk-owner-a",
      });

      const initial = await chunks.sync(input.noteId, "chunk-owner-a");
      expect(initial).toMatchObject({ status: "synchronized" });
      expect(initial.count).toBeGreaterThan(0);
      const first = (
        await chunks.listCurrentByOwner(input.noteId, "chunk-owner-a")
      )[0]!;
      expect(first.ownerSubject).toBe("chunk-owner-a");
      expect(first.sourceRevision).toBe(input.sourceRevision);
      expect(first.text.length).toBeGreaterThan(0);

      const embeddingId = createHash("sha256")
        .update(first.id + "/synthetic-model")
        .digest("hex");
      await client.chunkEmbedding.create({
        data: {
          id: embeddingId,
          chunkId: first.id,
          provider: "synthetic",
          modelId: "synthetic-1536",
          dimensions: 1536,
        },
      });
      const vector =
        "[" + ["1", ...Array<string>(1535).fill("0")].join(",") + "]";
      await client.$executeRaw`
      UPDATE "chunk_embeddings" SET "status" = 'READY', "vector" = ${vector}::vector
      WHERE "id" = ${embeddingId}
    `;
      const dimensions = await client.$queryRaw<Array<{ dimensions: number }>>`
      SELECT vector_dims("vector") AS dimensions FROM "chunk_embeddings"
      WHERE "id" = ${embeddingId}
    `;
      expect(dimensions).toEqual([{ dimensions: 1536 }]);

      expect(
        await notesRepo.importMarkdown({
          ...input,
          ownerSubject: "chunk-owner-a",
        }),
      ).toMatchObject({
        result: "replayed",
      });
      expect(await chunks.sync(input.noteId, "chunk-owner-a")).toMatchObject({
        status: "unchanged",
        count: initial.count,
      });
      expect(
        await client.chunkEmbedding.count({ where: { id: embeddingId } }),
      ).toBe(1);

      await notesRepo.importMarkdown({
        ...input,
        ownerSubject: "chunk-owner-a",
        expectedPreviousRevision: input.sourceRevision,
        sourceRevision: "r-" + randomUUID(),
        markdown: input.markdown.replace(
          "Synthetic summary.",
          "A revised synthetic summary.",
        ),
      });
      expect(
        await chunks.listCurrentByOwner(input.noteId, "chunk-owner-a"),
      ).toEqual([]);
      expect(
        await client.chunkEmbedding.count({ where: { id: embeddingId } }),
      ).toBe(0);
      expect(await chunks.sync(input.noteId, "chunk-owner-a")).toMatchObject({
        status: "synchronized",
      });
      const revised = (
        await chunks.listCurrentByOwner(input.noteId, "chunk-owner-a")
      )[0]!;
      expect(revised.noteContentHash).not.toBe(first.noteContentHash);
    });

    it("rejects foreign-owner claims at the DB boundary and in repository reads", async () => {
      const input = sample();
      await createNoteRepository(client).importMarkdown({
        ...input,
        ownerSubject: "chunk-owner-a",
      });
      const chunks = createNoteChunkRepository(client);
      expect(await chunks.sync(input.noteId, "chunk-owner-b")).toEqual({
        status: "missing",
        count: 0,
      });
      expect(
        await chunks.listCurrentByOwner(input.noteId, "chunk-owner-b"),
      ).toEqual([]);
      await chunks.sync(input.noteId, "chunk-owner-a");
      const chunk = (
        await chunks.listCurrentByOwner(input.noteId, "chunk-owner-a")
      )[0]!;
      await expect(
        client.noteChunk.create({
          data: {
            id: "f".repeat(64),
            noteId: input.noteId,
            ownerSubject: "chunk-owner-b",
            sourceRevision: input.sourceRevision,
            noteContentHash: chunk.noteContentHash,
            chunkerVersion: chunk.chunkerVersion,
            section: chunk.section,
            ordinal: 123,
            startOffset: 0,
            endOffset: 2,
            contentHash: "a".repeat(64),
            text: "No",
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      const unowned = sample();
      await createNoteRepository(client).importMarkdown(unowned);
      expect(await chunks.sync(unowned.noteId, "chunk-owner-a")).toMatchObject({
        status: "missing",
      });
    });

    it("invalidates chunks even for future direct DB note edits", async () => {
      const input = sample();
      await createNoteRepository(client).importMarkdown({
        ...input,
        ownerSubject: "writer-owner",
      });
      const chunks = createNoteChunkRepository(client);
      await chunks.sync(input.noteId, "writer-owner");
      expect(
        await chunks.listCurrentByOwner(input.noteId, "writer-owner"),
      ).not.toEqual([]);
      await client.note.update({
        where: { id: input.noteId },
        data: { summary: "Changed by a synthetic direct writer." },
      });
      expect(
        await chunks.listCurrentByOwner(input.noteId, "writer-owner"),
      ).toEqual([]);
    });

    it("provides bounded, resumable owner-only backfill scan without writing vectors", async () => {
      const inputA = sample();
      const inputB = sample();
      const inputC = sample();
      const repository = createNoteRepository(client);
      await repository.importMarkdown({
        ...inputA,
        ownerSubject: "scan-owner-a",
      });
      await repository.importMarkdown({
        ...inputB,
        ownerSubject: "scan-owner-a",
      });
      await repository.importMarkdown({
        ...inputC,
        ownerSubject: "scan-owner-b",
      });

      const chunks = createNoteChunkRepository(client);
      const page = await chunks.backfillPage("scan-owner-a", undefined, 1);
      expect(page).toHaveLength(1);
      const later = await chunks.backfillPage("scan-owner-a", page[0], 100);
      const matching = new Set([...page, ...later]);
      expect(matching.has(inputA.noteId)).toBe(true);
      expect(matching.has(inputB.noteId)).toBe(true);
      expect(matching.has(inputC.noteId)).toBe(false);
      expect(
        await client.chunkEmbedding.count({
          where: { chunk: { noteId: { in: [inputA.noteId, inputB.noteId] } } },
        }),
      ).toBe(0);
    });
  },
);
