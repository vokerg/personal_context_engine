import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  NoteValidationError,
  parseNoteMarkdown,
  verifyInboxNotePath,
} from "@pce/core";
import {
  createNoteRepository,
  ProjectionConflictError,
  type ImportMarkdownInput,
  type ImportOutcome,
} from "@pce/db";
import {
  ContentStoreError,
  type ContentRef,
  type ContentStore,
} from "./content-store/port.js";

export function workerStatus() {
  return { state: "idle" as const, imported: 0 };
}

const LEASE_MS = 5 * 60_000;
const MAX_BATCH = 100;
const MAX_SCAN = 1000;

export interface WorkerReport {
  scanned: number;
  imported: number;
  finalized: number;
  reconciled: number;
  rejected: number;
  retried: number;
  deferred: number;
}

export interface IngestionOptions {
  store: ContentStore;
  db: PrismaClient;
  workerId?: string;
  now?: () => Date;
  batchSize?: number;
  scanLimit?: number;
  /** Test seam only: inject a failing projection without changing ContentStore. */
  importMarkdown?: (input: ImportMarkdownInput) => Promise<ImportOutcome>;
}

function bounded(value: number, upper: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= upper;
}

/** Uses captured local calendar date, not UTC date or an inferred deadline. */
export function canonicalNotePath(
  capturedAtRaw: string,
  noteId: string,
): string {
  if (
    !/^\d{4}-(0[1-9]|1[0-2])-\d{2}T/.test(capturedAtRaw) ||
    !/^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(
      noteId,
    )
  ) {
    throw new Error("Invalid canonical note metadata.");
  }
  return `notes/${capturedAtRaw.slice(0, 4)}/${capturedAtRaw.slice(5, 7)}/${noteId}.md`;
}

export function retryDelayMs(attemptCount: number): number {
  return Math.min(
    60 * 60_000,
    5_000 * 2 ** Math.min(10, Math.max(0, attemptCount - 1)),
  );
}

function errorCode(error: unknown): string {
  if (error instanceof NoteValidationError) return "VALIDATION_" + error.code;
  if (error instanceof ProjectionConflictError)
    return "PROJECTION_" + error.code;
  if (error instanceof ContentStoreError) return "CONTENT_" + error.code;
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    /^[A-Z][0-9]{4}$/.test(error.code)
  )
    return "DB_" + error.code;
  return "TRANSIENT_FAILURE";
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Executes a finite, bounded import pass. Store and DB are intentionally
 * injected, allowing synthetic filesystem/PostgreSQL tests. No LLM calls and
 * no task/reminder execution occur here.
 */
export async function runIngestionBatch(
  options: IngestionOptions,
): Promise<WorkerReport> {
  const { store, db } = options;
  const now = options.now ?? (() => new Date());
  const owner = options.workerId ?? randomUUID();
  const batchSize = options.batchSize ?? 50;
  const scanLimit = options.scanLimit ?? 500;
  if (
    !bounded(batchSize, MAX_BATCH) ||
    !bounded(scanLimit, MAX_SCAN) ||
    !owner ||
    owner.length > 128
  ) {
    throw new Error("Invalid ingestion batch configuration.");
  }
  const project =
    options.importMarkdown ?? createNoteRepository(db).importMarkdown;
  const report: WorkerReport = {
    scanned: 0,
    imported: 0,
    finalized: 0,
    reconciled: 0,
    rejected: 0,
    retried: 0,
    deferred: 0,
  };

  function leaseWhere(
    path: string,
    revision: string,
    status: "LEASED" | "PERSISTED",
  ) {
    return {
      sourcePath: path,
      sourceRevision: revision,
      status,
      leaseOwner: owner,
      leaseUntil: { gt: now() },
    };
  }

  async function markRetry(
    ref: ContentRef,
    status: "LEASED" | "PERSISTED",
    failure: unknown,
  ): Promise<void> {
    const record = await db.processingAttempt.findUnique({
      where: {
        sourcePath_sourceRevision: {
          sourcePath: ref.path,
          sourceRevision: ref.revision,
        },
      },
      select: { attemptCount: true },
    });
    const delayedUntil = new Date(
      now().getTime() + retryDelayMs(record?.attemptCount ?? 1),
    );
    const update = await db.processingAttempt.updateMany({
      where: leaseWhere(ref.path, ref.revision, status),
      data: {
        status: status === "PERSISTED" ? "PERSISTED" : "RETRY",
        leaseOwner: null,
        leaseUntil: null,
        nextRetryAt: delayedUntil,
        lastErrorCode: errorCode(failure),
      },
    });
    if (update.count === 1) report.retried += 1;
  }

  async function markRejected(
    ref: ContentRef,
    error: unknown,
  ): Promise<boolean> {
    const update = await db.processingAttempt.updateMany({
      where: leaseWhere(ref.path, ref.revision, "LEASED"),
      data: {
        status: "REJECTED",
        leaseOwner: null,
        leaseUntil: null,
        nextRetryAt: null,
        lastErrorCode: errorCode(error),
      },
    });
    if (update.count === 1) report.rejected += 1;
    return update.count === 1;
  }

  async function finishPersisted(
    ref: ContentRef,
    noteId: string,
  ): Promise<void> {
    const note = await db.note.findUnique({ where: { id: noteId } });
    if (
      !note ||
      note.sourcePath !== ref.path ||
      note.sourceRevision !== ref.revision
    ) {
      throw new ProjectionConflictError("SOURCE_CONFLICT");
    }
    const destinationPath = canonicalNotePath(note.capturedAtRaw, noteId);
    // Idempotent transition handles source already moved and interrupted copies.
    // Never move an input before its durable projection is confirmed.
    await store.finalize({
      sourcePath: ref.path,
      expectedRevision: ref.revision,
      destinationPath,
    });
    const updated = await db.note.updateMany({
      where: { id: noteId, sourcePath: ref.path, sourceRevision: ref.revision },
      data: { state: "FINALIZED", canonicalPath: destinationPath },
    });
    if (updated.count !== 1)
      throw new ProjectionConflictError("REVISION_CONFLICT");
    const completed = await db.processingAttempt.updateMany({
      where: leaseWhere(ref.path, ref.revision, "PERSISTED"),
      data: {
        status: "FINALIZED",
        leaseOwner: null,
        leaseUntil: null,
        nextRetryAt: null,
        lastErrorCode: null,
        finalizedAt: now(),
      },
    });
    if (completed.count !== 1) {
      // Another worker may have taken an expired lease; it can reconcile.
      throw new Error("Ingestion lease changed during finalization.");
    }
    report.finalized += 1;
  }

  // Recover durable DB commits even if a previous worker moved the file and
  // crashed before recording FINALIZED. Inbox discovery alone cannot do this.
  const pending = await db.processingAttempt.findMany({
    where: {
      status: "PERSISTED",
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now() } }],
      AND: [{ OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now() } }] }],
    },
    orderBy: { updatedAt: "asc" },
    take: batchSize,
  });
  let processed = 0;
  for (const attempt of pending) {
    const acquired = await db.processingAttempt.updateMany({
      where: {
        id: attempt.id,
        status: "PERSISTED",
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now() } }],
        AND: [{ OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now() } }] }],
      },
      data: {
        leaseOwner: owner,
        leaseUntil: new Date(now().getTime() + LEASE_MS),
        attemptCount: { increment: 1 },
      },
    });
    if (acquired.count !== 1) continue;
    processed += 1;
    const ref = { path: attempt.sourcePath, revision: attempt.sourceRevision };
    try {
      if (!attempt.noteId) throw new Error("Missing durable projection link.");
      await finishPersisted(ref, attempt.noteId);
      report.reconciled += 1;
    } catch (error) {
      await markRetry(ref, "PERSISTED", error);
    }
  }

  // The cursor advances even across deferred entries so a single poison
  // inbox item cannot permanently starve later valid files.
  let cursor: string | undefined;
  while (report.scanned < scanLimit && processed < batchSize) {
    const page = await store.listPending({
      ...(cursor ? { cursor } : {}),
      limit: Math.min(50, scanLimit - report.scanned),
    });
    if (page.files.length === 0) break;
    for (const ref of page.files) {
      if (processed >= batchSize || report.scanned >= scanLimit) break;
      report.scanned += 1;
      try {
        await db.processingAttempt.create({
          data: { sourcePath: ref.path, sourceRevision: ref.revision },
        });
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
      }
      const claimed = await db.processingAttempt.updateMany({
        where: {
          sourcePath: ref.path,
          sourceRevision: ref.revision,
          OR: [
            { status: "PENDING" },
            {
              status: "RETRY",
              OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now() } }],
            },
            { status: "LEASED", leaseUntil: { lte: now() } },
          ],
        },
        data: {
          status: "LEASED",
          leaseOwner: owner,
          leaseUntil: new Date(now().getTime() + LEASE_MS),
          attemptCount: { increment: 1 },
          nextRetryAt: null,
          lastErrorCode: null,
        },
      });
      if (claimed.count !== 1) {
        // A validator failure is durable before the rejected/ move.
        // Reconcile a failed/interrupted move without parsing or deleting
        // changed source bytes. Identity conflicts remain for human repair.
        const prior = await db.processingAttempt.findUnique({
          where: {
            sourcePath_sourceRevision: {
              sourcePath: ref.path,
              sourceRevision: ref.revision,
            },
          },
          select: { status: true, lastErrorCode: true },
        });
        if (
          prior?.status === "REJECTED" &&
          prior.lastErrorCode?.startsWith("VALIDATION_")
        ) {
          try {
            await store.reject({
              sourcePath: ref.path,
              expectedRevision: ref.revision,
            });
          } catch {
            report.retried += 1;
          }
        }
        report.deferred += 1;
        continue;
      }
      processed += 1;
      let noteId: string;
      try {
        const file = await store.read(ref.path);
        if (file.revision !== ref.revision) {
          // A stale discovery revision must never move a newer file.
          await markRejected(
            ref,
            new ContentStoreError("REVISION_CONFLICT", "Revision changed."),
          );
          continue;
        }
        let parsed;
        try {
          parsed = parseNoteMarkdown(file.content);
          verifyInboxNotePath(ref.path, parsed.metadata);
        } catch (error) {
          if (!(error instanceof NoteValidationError)) throw error;
          // Commit the validation error before moving the source, so a
          // crash or DB outage cannot strand a moved file without a reason.
          const recorded = await markRejected(ref, error);
          if (recorded) {
            try {
              await store.reject({
                sourcePath: ref.path,
                expectedRevision: ref.revision,
              });
            } catch {
              // REJECTED remains durable; the next bounded scan retries
              // only this revision's pending content transition.
              report.retried += 1;
            }
          }
          continue;
        }
        noteId = parsed.metadata.id;
        const result = await project({
          markdown: file.content,
          sourcePath: ref.path,
          sourceRevision: ref.revision,
        });
        const recorded = await db.processingAttempt.updateMany({
          where: leaseWhere(ref.path, ref.revision, "LEASED"),
          data: {
            status: "PERSISTED",
            noteId: result.noteId,
            committedAt: now(),
          },
        });
        if (recorded.count !== 1)
          throw new Error("Ingestion lease expired after DB commit.");
        if (result.result !== "replayed") report.imported += 1;
      } catch (error) {
        if (error instanceof ProjectionConflictError) {
          // Identity/capture collisions require operator repair, not retries
          // and not an automatic move to rejected/.
          await markRejected(ref, error);
        } else {
          await markRetry(ref, "LEASED", error);
        }
        continue;
      }
      try {
        await finishPersisted(ref, noteId);
      } catch (error) {
        await markRetry(ref, "PERSISTED", error);
      }
    }
    if (!page.nextCursor || processed >= batchSize) break;
    cursor = page.nextCursor;
  }
  return report;
}
