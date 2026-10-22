import { randomUUID } from "node:crypto";
import {
  createTagSnapshotRepository,
  TagSnapshotTooLargeError,
  type PrismaClient,
} from "@pce/db";
import {
  SnapshotPublishError,
  type ApprovedTagSnapshot,
} from "./tag-snapshot-publisher.js";

type Publisher = {
  publish(
    snapshot: ApprovedTagSnapshot,
  ): Promise<{ hash: string; changed: boolean }>;
};

/** One bounded taxonomy job on the existing DB worker, independent of note jobs. */
export async function runTagSnapshotPass(
  db: PrismaClient,
  ownerSubject: string,
  publisher: Publisher,
  workerId = randomUUID(),
  now = new Date(),
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(ownerSubject))
    throw new Error("Invalid trusted owner");
  const result = { published: 0, unchanged: 0, retried: 0, failed: 0 };
  const job = await db.$transaction(async (tx) => {
    // An empty, never-mutated approved registry also has a valid revision 0.
    await tx.tagSnapshotOutbox.upsert({
      where: { ownerSubject },
      create: { ownerSubject, desiredRevision: 0 },
      update: {},
    });
    await tx.tagSnapshotOutbox.updateMany({
      where: {
        ownerSubject,
        status: "LEASED",
        leaseUntil: { lte: now },
        attemptCount: { gte: 6 },
      },
      data: {
        status: "FAILED",
        leaseOwner: null,
        leaseUntil: null,
        lastErrorCode: "LEASE_EXHAUSTED",
      },
    });
    const [row] = await tx.$queryRaw<
      Array<{
        ownerSubject: string;
        desiredRevision: number;
        attemptCount: number;
      }>
    >`SELECT "ownerSubject","desiredRevision","attemptCount"
      FROM "tag_snapshot_outbox"
      WHERE "ownerSubject"=${ownerSubject} AND "attemptCount"<6
        AND ("status"='PENDING'
          OR ("status"='RETRY' AND "nextRetryAt" <= ${now})
          OR ("status"='LEASED' AND "leaseUntil" <= ${now}))
      FOR UPDATE SKIP LOCKED`;
    if (!row) return null;
    await tx.tagSnapshotOutbox.update({
      where: { ownerSubject },
      data: {
        status: "LEASED",
        leaseOwner: workerId,
        leaseUntil: new Date(now.getTime() + 120_000),
        attemptCount: { increment: 1 },
      },
    });
    return { ...row, attemptCount: row.attemptCount + 1 };
  });
  if (!job) return result;
  try {
    const snapshot =
      await createTagSnapshotRepository(db).readApproved(ownerSubject);
    const written = await publisher.publish(snapshot);
    const finished = await db.tagSnapshotOutbox.updateMany({
      where: {
        ownerSubject,
        desiredRevision: snapshot.revision,
        status: "LEASED",
        leaseOwner: workerId,
        leaseUntil: { gt: new Date() },
      },
      data: {
        status: "PUBLISHED",
        publishedRevision: snapshot.revision,
        publishedHash: written.hash,
        publishedAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
        lastErrorCode: null,
        nextRetryAt: null,
      },
    });
    if (finished.count) {
      if (written.changed) result.published++;
      else result.unchanged++;
    }
  } catch (error) {
    // Fixed codes only; never log original exception text or GitHub payload.
    const code =
      error instanceof TagSnapshotTooLargeError
        ? "REGISTRY_TOO_LARGE"
        : error instanceof SnapshotPublishError
          ? error.code
          : "PUBLISH_UNAVAILABLE";
    const terminal = code === "REGISTRY_TOO_LARGE" || job.attemptCount >= 6;
    const changed = await db.tagSnapshotOutbox.updateMany({
      where: {
        ownerSubject,
        desiredRevision: job.desiredRevision,
        status: "LEASED",
        leaseOwner: workerId,
        leaseUntil: { gt: new Date() },
      },
      data: {
        status: terminal ? "FAILED" : "RETRY",
        attemptCount: terminal ? 6 : job.attemptCount,
        leaseOwner: null,
        leaseUntil: null,
        nextRetryAt: terminal
          ? null
          : new Date(
              now.getTime() + Math.min(3_600_000, 5000 * 2 ** job.attemptCount),
            ),
        lastErrorCode: code,
      },
    });
    if (changed.count) {
      if (terminal) result.failed++;
      else result.retried++;
    }
  }
  return result;
}
