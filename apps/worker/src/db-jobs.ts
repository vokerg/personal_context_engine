import { randomUUID } from "node:crypto";
import {
  createEmbeddingJobRepository,
  createResearchEmbeddingRepository,
  type PrismaClient,
} from "@pce/db";

/** A bounded durable job pass: prepares derived DB jobs, never calls a provider. */
export async function runDbJobPass(
  db: PrismaClient,
  ownerSubject: string,
  workerId = randomUUID(),
  now = new Date(),
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(ownerSubject))
    throw new Error("Invalid trusted owner");
  const report = { prepared: 0, retried: 0, failed: 0 };
  for (let i = 0; i < 16; i++) {
    const job = await db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "db_processing_jobs" j SET "status"='FAILED',"leaseOwner"=NULL,"leaseUntil"=NULL,"lastErrorCode"='NOTE_REMOVED'
    FROM "notes" n WHERE j."noteId"=n."id" AND j."ownerSubject"=${ownerSubject} AND n."ownerSubject"=${ownerSubject}
    AND n."removedAt" IS NOT NULL AND j."status" IN ('PENDING','RETRY','LEASED')`;
      await tx.$executeRaw`UPDATE "db_processing_jobs" j SET "status"='FAILED',"leaseOwner"=NULL,"leaseUntil"=NULL,"lastErrorCode"='SOURCE_CHANGED'
    FROM "notes" n WHERE j."noteId"=n."id" AND j."ownerSubject"=${ownerSubject} AND n."ownerSubject"=${ownerSubject}
    AND j."sourceRevision"<>n."sourceRevision" AND j."status" IN ('PENDING','RETRY','LEASED')`;
      await tx.dbProcessingJob.updateMany({
        where: {
          ownerSubject,
          status: "LEASED",
          attemptCount: { gte: 6 },
          leaseUntil: { lte: now },
        },
        data: {
          status: "FAILED",
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: "LEASE_EXHAUSTED",
        },
      });
      const [row] = await tx.$queryRaw<
        Array<{ id: string; noteId: string; attemptCount: number }>
      >`SELECT j."id",j."noteId",j."attemptCount" FROM "db_processing_jobs" j
    INNER JOIN "notes" n ON n."id"=j."noteId" AND n."ownerSubject"=j."ownerSubject" AND n."sourceRevision"=j."sourceRevision" AND n."removedAt" IS NULL
    WHERE j."ownerSubject"=${ownerSubject} AND j."attemptCount"<6 AND (j."status"='PENDING' OR (j."status"='RETRY' AND j."nextRetryAt"<=${now}) OR (j."status"='LEASED' AND j."leaseUntil"<=${now}))
    ORDER BY j."createdAt",j."id" LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
      if (!row) return null;
      await tx.dbProcessingJob.update({
        where: { id: row.id },
        data: {
          status: "LEASED",
          leaseOwner: workerId,
          leaseUntil: new Date(now.getTime() + 120000),
          attemptCount: { increment: 1 },
        },
      });
      return { ...row, attemptCount: row.attemptCount + 1 };
    });
    if (!job) break;
    try {
      const result = await createEmbeddingJobRepository(db).prepareNote(
        job.noteId,
        ownerSubject,
      );
      const failed =
        result.status === "oversized" || result.status === "missing";
      const changed = await db.dbProcessingJob.updateMany({
        where: {
          id: job.id,
          ownerSubject,
          status: "LEASED",
          leaseOwner: workerId,
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: failed ? "FAILED" : "PREPARED",
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: failed ? "PREPARATION_LIMIT" : null,
        },
      });
      if (changed.count) {
        if (failed) report.failed++;
        else report.prepared++;
      }
    } catch {
      const terminal = job.attemptCount >= 6;
      const changed = await db.dbProcessingJob.updateMany({
        where: {
          id: job.id,
          ownerSubject,
          status: "LEASED",
          leaseOwner: workerId,
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: terminal ? "FAILED" : "RETRY",
          leaseOwner: null,
          leaseUntil: null,
          nextRetryAt: new Date(
            now.getTime() + Math.min(3600000, 5000 * 2 ** job.attemptCount),
          ),
          lastErrorCode: "PREPARATION_UNAVAILABLE",
        },
      });
      if (changed.count) {
        if (terminal) report.failed++;
        else report.retried++;
      }
    }
  }
  if (process.env.PCE_RESEARCH_REPORTS === "true") {
    const research = createResearchEmbeddingRepository(db);
    for (const id of await research.candidateNotes(ownerSubject))
      await research.prepareNote(id, ownerSubject);
  }
  return report;
}
