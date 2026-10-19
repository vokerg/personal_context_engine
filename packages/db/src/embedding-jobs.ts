import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { CHUNKER_VERSION } from "@pce/core";
import { createNoteChunkRepository } from "./chunks.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_TOKEN_RESERVATION = 8192;
export const EMBEDDING_DAILY_TOKEN_LIMIT = 60_000;
export const EMBEDDING_REQUESTS_PER_MINUTE = 4;
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
      const checkpoint =
        afterId === undefined
          ? await db.embeddingScan.findUnique({ where: { ownerSubject } })
          : null;
      const cursor = afterId ?? checkpoint?.afterNoteId ?? "";
      const notes = await db.$queryRaw<Array<{ id: string }>>`
        SELECT n."id" FROM "notes" n
        WHERE n."ownerSubject" = ${ownerSubject}
          AND (${cursor} = '' OR n."id" > ${cursor})
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

    async checkpointScan(ownerSubject: string, afterNoteId: string | null) {
      validOwner(ownerSubject);
      if (afterNoteId !== null && !/^[0-9a-zA-Z-]{1,36}$/.test(afterNoteId))
        throw new TypeError("Invalid note cursor");
      await db.embeddingScan.upsert({
        where: { ownerSubject },
        create: { ownerSubject, afterNoteId },
        update: { afterNoteId },
      });
    },

    async claim(
      ownerSubject: string,
      workerId: string,
      now: Date,
    ): Promise<EmbeddingJob | null> {
      validOwner(ownerSubject);
      validWorker(workerId);
      return db.$transaction(async (tx) => {
        const day = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        // Serialize the budget AND job claim for this owner/day. Reservations
        // are never refunded: the provider may charge even if the reply is lost.
        await tx.$executeRaw`
          INSERT INTO "embedding_scans" ("ownerSubject", "windowStartedAt")
          VALUES (${ownerSubject}, ${now}) ON CONFLICT DO NOTHING
        `;
        const [rate] = await tx.$queryRaw<
          Array<{ windowStartedAt: Date; windowRequests: number }>
        >`
          SELECT "windowStartedAt", "windowRequests" FROM "embedding_scans"
          WHERE "ownerSubject" = ${ownerSubject} FOR UPDATE
        `;
        if (!rate) throw new Error("Embedding rate state unavailable");
        await tx.$executeRaw`
          INSERT INTO "embedding_daily_budgets" ("ownerSubject", "day")
          VALUES (${ownerSubject}, ${day.toISOString().slice(0, 10)}::date) ON CONFLICT DO NOTHING
        `;
        const [budget] = await tx.$queryRaw<Array<{ reservedTokens: number }>>`
          SELECT "reservedTokens" FROM "embedding_daily_budgets"
          WHERE "ownerSubject" = ${ownerSubject} AND "day" = ${day.toISOString().slice(0, 10)}::date
          FOR UPDATE
        `;
        if (!budget) throw new Error("Embedding budget unavailable");
        const newWindow =
          now.getTime() - rate.windowStartedAt.getTime() >= 60_000;
        if (
          budget.reservedTokens + EMBEDDING_TOKEN_RESERVATION >
            EMBEDDING_DAILY_TOKEN_LIMIT ||
          (!newWindow && rate.windowRequests >= EMBEDDING_REQUESTS_PER_MINUTE)
        )
          return null;
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
        await tx.embeddingDailyBudget.update({
          where: { ownerSubject_day: { ownerSubject, day } },
          data: {
            reservedTokens: { increment: EMBEDDING_TOKEN_RESERVATION },
            requestCount: { increment: 1 },
          },
        });
        await tx.embeddingScan.update({
          where: { ownerSubject },
          data: {
            windowStartedAt: newWindow ? now : rate.windowStartedAt,
            windowRequests: newWindow ? 1 : rate.windowRequests + 1,
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
          AND e."provider" = ${PROVIDER}
          AND e."dimensions" = ${EMBEDDING_DIMENSIONS}
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

    async reservedTokensToday(
      ownerSubject: string,
      now: Date,
    ): Promise<number> {
      validOwner(ownerSubject);
      const day = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const budget = await db.embeddingDailyBudget.findUnique({
        where: { ownerSubject_day: { ownerSubject, day } },
      });
      return budget?.reservedTokens ?? 0;
    },
  };
}
