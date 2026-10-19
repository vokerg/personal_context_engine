import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { CHUNKER_VERSION } from "@pce/core";
import { createNoteChunkRepository } from "./chunks.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
const PROVIDER = "openai";
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type EmbeddingJob = {
  id: string;
  chunkId: string;
  text: string;
  attemptCount: number;
};

export type EmbeddingFailureCode =
  | "RATE_LIMIT"
  | "PROVIDER_5XX"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_4XX"
  | "INVALID_RESPONSE";

function validOwner(owner: string): void {
  if (!OWNER.test(owner)) throw new TypeError("Invalid verified owner subject");
}
function validWorker(worker: string): void {
  if (!WORKER.test(worker)) throw new TypeError("Invalid trusted worker ID");
}

function jobId(chunkId: string): string {
  return createHash("sha256")
    .update(
      [
        "pce-embedding",
        PROVIDER,
        EMBEDDING_MODEL,
        EMBEDDING_DIMENSIONS,
        chunkId,
      ].join("\0"),
    )
    .digest("hex");
}

/**
 * A bounded, tenant-scoped, durable DB queue. All claims and completions check
 * current note ownership and revision inside SQL; stale provider replies cannot
 * resurrect a deleted/revised chunk. No GitHub service is consulted.
 */
export function createEmbeddingJobRepository(db: PrismaClient) {
  const chunkRepository = createNoteChunkRepository(db);
  return {
    async prepareNote(noteId: string, ownerSubject: string) {
      validOwner(ownerSubject);
      const status = await chunkRepository.sync(noteId, ownerSubject);
      if (status.status === "missing" || status.status === "oversized")
        return status;
      const chunks = await chunkRepository.listCurrentByOwner(
        noteId,
        ownerSubject,
      );
      if (chunks.length) {
        await db.chunkEmbedding.createMany({
          data: chunks.map((chunk) => ({
            id: jobId(chunk.id),
            chunkId: chunk.id,
            provider: PROVIDER,
            modelId: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
          })),
          skipDuplicates: true,
        });
      }
      return status;
    },

    /** Find a small owner-only page needing queue preparation. Optional cursor
     * allows operators to skip an invalid/oversized note without losing data.
     * This performs no provider calls and does not claim completion.
     */
    async candidateNotes(
      ownerSubject: string,
      afterId?: string,
    ): Promise<string[]> {
      validOwner(ownerSubject);
      if (afterId !== undefined && !/^[0-9a-zA-Z-]{1,36}$/.test(afterId))
        throw new TypeError("Invalid note cursor");
      const notes = await db.$queryRaw<Array<{ id: string }>>`
        SELECT n."id" FROM "notes" n
        WHERE n."ownerSubject" = ${ownerSubject}
          AND (${afterId ?? ""} = '' OR n."id" > ${afterId ?? ""})
          AND (
            NOT EXISTS (
              SELECT 1 FROM "note_chunks" c
              WHERE c."noteId" = n."id" AND c."ownerSubject" = n."ownerSubject"
                AND c."sourceRevision" = n."sourceRevision"
                AND c."noteContentHash" = n."contentHash"
                AND c."chunkerVersion" = ${CHUNKER_VERSION}
            )
            OR EXISTS (
              SELECT 1 FROM "note_chunks" c
              WHERE c."noteId" = n."id" AND c."ownerSubject" = n."ownerSubject"
                AND c."sourceRevision" = n."sourceRevision"
                AND c."noteContentHash" = n."contentHash"
                AND c."chunkerVersion" = ${CHUNKER_VERSION}
                AND NOT EXISTS (
                  SELECT 1 FROM "chunk_embeddings" e
                  WHERE e."chunkId" = c."id" AND e."modelId" = ${EMBEDDING_MODEL}
                    AND e."dimensions" = ${EMBEDDING_DIMENSIONS}
                )
            )
          )
        ORDER BY n."id" ASC LIMIT 16
      `;
      return notes.map((n) => n.id);
    },

    async claim(
      ownerSubject: string,
      workerId: string,
      now: Date,
    ): Promise<EmbeddingJob | null> {
      validOwner(ownerSubject);
      validWorker(workerId);
      return db.$transaction(async (tx) => {
        // A crash after the final paid attempt must not leave a permanent
        // expired LEASED row that no worker can ever claim again.
        await tx.chunkEmbedding.updateMany({
          where: {
            status: "LEASED",
            attemptCount: { gte: 6 },
            leaseUntil: { lte: now },
            chunk: { ownerSubject, note: { ownerSubject } },
          },
          data: {
            status: "FAILED",
            leaseOwner: null,
            leaseUntil: null,
            lastErrorCode: "LEASE_EXHAUSTED",
          },
        });
        const rows = await tx.$queryRaw<EmbeddingJob[]>`
          SELECT e."id", c."id" AS "chunkId", c."text", e."attemptCount"
          FROM "chunk_embeddings" e
          INNER JOIN "note_chunks" c ON c."id" = e."chunkId"
          INNER JOIN "notes" n ON n."id" = c."noteId"
            AND n."ownerSubject" = c."ownerSubject"
          WHERE c."ownerSubject" = ${ownerSubject}
            AND c."sourceRevision" = n."sourceRevision"
            AND c."noteContentHash" = n."contentHash"
            AND c."chunkerVersion" = ${CHUNKER_VERSION}
            AND e."provider" = ${PROVIDER}
            AND e."modelId" = ${EMBEDDING_MODEL}
            AND e."dimensions" = ${EMBEDDING_DIMENSIONS}
            AND (
              e."status" = 'PENDING'
              OR (e."status" = 'RETRY' AND e."nextRetryAt" <= ${now})
              OR (e."status" = 'LEASED' AND e."leaseUntil" <= ${now})
            )
            AND e."attemptCount" < 6
          ORDER BY e."createdAt", e."id"
          LIMIT 1 FOR UPDATE OF e SKIP LOCKED
        `;
        const job = rows[0];
        if (!job) return null;
        await tx.chunkEmbedding.update({
          where: { id: job.id },
          data: {
            status: "LEASED",
            leaseOwner: workerId,
            leaseUntil: new Date(now.getTime() + 120_000),
            nextRetryAt: null,
            attemptCount: { increment: 1 },
          },
        });
        return { ...job, attemptCount: job.attemptCount + 1 };
      });
    },

    /** Atomic compare-and-set against lease + owner + current source. */
    async complete(
      ownerSubject: string,
      workerId: string,
      id: string,
      vector: number[],
      usageTokens: number,
      now: Date,
    ): Promise<boolean> {
      validOwner(ownerSubject);
      validWorker(workerId);
      if (
        vector.length !== EMBEDDING_DIMENSIONS ||
        vector.some((x) => !Number.isFinite(x))
      )
        throw new TypeError("Invalid embedding dimensions or values");
      if (
        !Number.isSafeInteger(usageTokens) ||
        usageTokens < 0 ||
        usageTokens > 1_000_000
      )
        throw new TypeError("Invalid provider usage");
      const literal = "[" + vector.join(",") + "]";
      const changed = await db.$executeRaw`
        UPDATE "chunk_embeddings" e
        SET "status" = 'READY', "vector" = ${literal}::vector,
            "usageTokens" = ${usageTokens},
            "estimatedCostNanoUsd" = ${BigInt(usageTokens) * 20n},
            "indexedAt" = ${now}, "leaseOwner" = NULL, "leaseUntil" = NULL,
            "nextRetryAt" = NULL, "lastErrorCode" = NULL, "updatedAt" = ${now}
        FROM "note_chunks" c INNER JOIN "notes" n
          ON n."id" = c."noteId" AND n."ownerSubject" = c."ownerSubject"
        WHERE e."id" = ${id} AND e."chunkId" = c."id"
          AND e."status" = 'LEASED' AND e."leaseOwner" = ${workerId}
          AND e."leaseUntil" > ${now}
          AND c."ownerSubject" = ${ownerSubject}
          AND c."sourceRevision" = n."sourceRevision"
          AND c."noteContentHash" = n."contentHash"
          AND c."chunkerVersion" = ${CHUNKER_VERSION}
          AND e."modelId" = ${EMBEDDING_MODEL}
      `;
      return changed === 1;
    },

    async fail(
      ownerSubject: string,
      workerId: string,
      id: string,
      code: EmbeddingFailureCode,
      retryable: boolean,
      attempt: number,
      now: Date,
    ): Promise<boolean> {
      validOwner(ownerSubject);
      validWorker(workerId);
      const delay = Math.min(
        3_600_000,
        5000 * 2 ** Math.min(10, Math.max(0, attempt - 1)),
      );
      const terminal = !retryable || attempt >= 6;
      const updated = await db.chunkEmbedding.updateMany({
        where: {
          id,
          leaseOwner: workerId,
          status: "LEASED",
          leaseUntil: { gt: now },
          chunk: { ownerSubject, note: { ownerSubject } },
        },
        data: {
          status: terminal ? "FAILED" : "RETRY",
          leaseOwner: null,
          leaseUntil: null,
          nextRetryAt: terminal ? null : new Date(now.getTime() + delay),
          lastErrorCode: code,
        },
      });
      return updated.count === 1;
    },

    async usedTokensToday(ownerSubject: string, now: Date): Promise<number> {
      validOwner(ownerSubject);
      const midnight = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const rows = await db.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM(e."usageTokens"), 0)::bigint AS total
        FROM "chunk_embeddings" e INNER JOIN "note_chunks" c ON c."id" = e."chunkId"
        WHERE c."ownerSubject" = ${ownerSubject} AND e."indexedAt" >= ${midnight}
      `;
      return Number(rows[0]?.total ?? 0n);
    },
  };
}
