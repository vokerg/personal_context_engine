import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { CHUNKER_VERSION } from "@pce/core";
import { chunkNoteText } from "@pce/core";
import { ResearchArtifactSchema } from "@pce/contracts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_TOKEN_RESERVATION,
  EMBEDDING_DAILY_TOKEN_LIMIT,
  EMBEDDING_REQUESTS_PER_MINUTE,
  type EmbeddingJob,
  type EmbeddingFailureCode,
} from "./embedding-jobs.js";

const PROVIDER = "openai";
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
 * immutable report ownership and hash inside SQL; stale provider replies cannot
 * resurrect a deleted/revised chunk. No GitHub service is consulted.
 */
export function createResearchEmbeddingRepository(db: PrismaClient) {
  return {
    async prepareNote(reportId: string, ownerSubject: string) {
      validOwner(ownerSubject);
      return db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            artifact: unknown;
            contentHash: string;
            sourceRevision: string;
          }>
        >`
          SELECT r."id", r."artifact", r."contentHash", r."sourceRevision"
          FROM research_reports r
          INNER JOIN notes n ON n."id"=r."parentNoteId"
            AND n."ownerSubject"=r."ownerSubject" AND n."removedAt" IS NULL
          WHERE r."id"=${reportId} AND r."ownerSubject"=${ownerSubject} FOR UPDATE`;
        const row = rows[0];
        if (!row) return { status: "missing", count: 0 };
        const report = ResearchArtifactSchema.parse(row.artifact);
        const chunks = chunkNoteText({
          noteId: reportId,
          originalInput: "",
          summary: "",
          body: [
            report.title,
            report.question,
            report.findings,
            ...report.claims.map((c) => c.classification + ": " + c.text),
            ...report.limitations,
          ].join("\n\n"),
        });
        await tx.researchChunk.createMany({
          data: chunks.map((c) => ({
            ...c,
            reportId,
            ownerSubject,
            sourceRevision: row.sourceRevision,
            reportContentHash: row.contentHash,
            chunkerVersion: CHUNKER_VERSION,
          })),
          skipDuplicates: true,
        });
        await tx.researchEmbedding.createMany({
          data: chunks.map((c) => ({
            id: jobId(c.id),
            chunkId: c.id,
            provider: PROVIDER,
            modelId: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
          })),
          skipDuplicates: true,
        });
        return { status: "synchronized", count: chunks.length };
      });
    },
    async candidateNotes(ownerSubject: string): Promise<string[]> {
      validOwner(ownerSubject);
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT r.id FROM research_reports r
        INNER JOIN notes n ON n."id"=r."parentNoteId"
          AND n."ownerSubject"=r."ownerSubject" AND n."removedAt" IS NULL
        WHERE r."ownerSubject"=${ownerSubject}
        AND NOT EXISTS(SELECT 1 FROM research_chunks c JOIN research_embeddings e ON e."chunkId"=c.id
          WHERE c."reportId"=r.id AND c."ownerSubject"=r."ownerSubject" AND c."chunkerVersion"=${CHUNKER_VERSION}
            AND e."modelId"=${EMBEDDING_MODEL} AND e.dimensions=${EMBEDDING_DIMENSIONS})
        ORDER BY r.id LIMIT 16`;
      return rows.map((r) => r.id);
    },
    async checkpointScan() {
      /* Immutable reports leave the candidate set after preparation. */
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
          budget.reservedTokens >= EMBEDDING_DAILY_TOKEN_LIMIT ||
          (!newWindow && rate.windowRequests >= EMBEDDING_REQUESTS_PER_MINUTE)
        )
          return null;
        // A crash after the final paid attempt must not leave a permanent
        // expired LEASED row that no worker can ever claim again.
        await tx.researchEmbedding.updateMany({
          where: {
            status: "LEASED",
            attemptCount: { gte: 6 },
            leaseUntil: { lte: now },
            chunk: { ownerSubject, report: { ownerSubject } },
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
          FROM "research_embeddings" e
          INNER JOIN "research_chunks" c ON c."id" = e."chunkId"
          INNER JOIN "research_reports" n ON n."id" = c."reportId"
            AND n."ownerSubject" = c."ownerSubject"
          INNER JOIN "notes" p ON p."id" = n."parentNoteId"
            AND p."ownerSubject" = n."ownerSubject" AND p."removedAt" IS NULL
          WHERE c."ownerSubject" = ${ownerSubject}
            AND c."sourceRevision" = n."sourceRevision"
            AND c."reportContentHash" = n."contentHash"
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
        const reservation = Math.min(
          EMBEDDING_TOKEN_RESERVATION,
          Buffer.byteLength(job.text, "utf8") + 16,
        );
        if (budget.reservedTokens + reservation > EMBEDDING_DAILY_TOKEN_LIMIT)
          return null;
        await tx.researchEmbedding.update({
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
            reservedTokens: { increment: reservation },
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
        UPDATE "research_embeddings" e
        SET "status" = 'READY', "vector" = ${literal}::vector,
            "usageTokens" = ${usageTokens},
            "estimatedCostNanoUsd" = ${BigInt(usageTokens) * 20n},
            "indexedAt" = ${now}, "leaseOwner" = NULL, "leaseUntil" = NULL,
            "nextRetryAt" = NULL, "lastErrorCode" = NULL, "updatedAt" = ${now}
        FROM "research_chunks" c INNER JOIN "research_reports" n
          ON n."id" = c."reportId" AND n."ownerSubject" = c."ownerSubject"
        INNER JOIN "notes" p ON p."id" = n."parentNoteId"
          AND p."ownerSubject" = n."ownerSubject" AND p."removedAt" IS NULL
        WHERE e."id" = ${id} AND e."chunkId" = c."id"
          AND e."status" = 'LEASED' AND e."leaseOwner" = ${workerId}
          AND e."leaseUntil" > ${now}
          AND c."ownerSubject" = ${ownerSubject}
          AND c."sourceRevision" = n."sourceRevision"
          AND c."reportContentHash" = n."contentHash"
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
      const updated = await db.researchEmbedding.updateMany({
        where: {
          id,
          leaseOwner: workerId,
          status: "LEASED",
          leaseUntil: { gt: now },
          chunk: { ownerSubject, report: { ownerSubject } },
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
