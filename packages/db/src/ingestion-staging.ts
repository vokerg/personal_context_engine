import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  parseNoteMarkdown,
  verifyInboxNotePath,
  NoteValidationError,
} from "@pce/core";
import { createNoteRepository, ProjectionConflictError } from "./index.js";
import { createResearchRepository } from "./research.js";
import { createTaskExtractionRepository } from "./task-extraction.js";

/** Same DB-only processor on every host. Importers commit idempotently first;
 * job scheduling and acknowledgement then commit together under a fenced lease.
 * A crash in between replays the immutable canonical import on the next claim.
 */
export async function processStagingPass(
  db: PrismaClient,
  ownerSubject: string,
  options: {
    limit?: number;
    workerId?: string;
    now?: () => Date;
    afterPersist?: () => Promise<void>;
  } = {},
) {
  const limit = options.limit ?? 16;
  const worker = options.workerId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !worker ||
    worker.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(ownerSubject)
  )
    throw new TypeError("Invalid staging processor configuration");
  const report = { claimed: 0, processed: 0, invalid: 0, retried: 0 };
  for (let i = 0; i < limit; i++) {
    const current = now();
    const lease = new Date(current.getTime() + 300000);
    const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidate AS (
        SELECT id FROM ingestion_staging
        WHERE "ownerSubject" = ${ownerSubject}
          AND (status = 'PENDING' OR (status = 'RETRY' AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${current})) OR (status = 'LEASED' AND "leaseUntil" <= ${current}))
        ORDER BY "fetchedAt", id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE ingestion_staging s SET status = 'LEASED', "leaseOwner" = ${worker}, "leaseUntil" = ${lease}, "attemptCount" = "attemptCount" + 1, "nextRetryAt" = NULL
      FROM candidate c WHERE s.id = c.id RETURNING s.id`);
    if (!rows.length) break;
    const row = await db.ingestionStaging.findUniqueOrThrow({
      where: { id: rows[0]!.id },
    });
    report.claimed++;
    const fence = () => ({
      id: row.id,
      ownerSubject,
      status: "LEASED",
      leaseOwner: worker,
      attemptCount: row.attemptCount,
      leaseUntil: { gt: now() },
    });
    try {
      if (
        row.provider !== "github" ||
        createHash("sha256").update(row.rawContent).digest("hex") !==
          row.contentHash
      )
        throw new TypeError("Invalid staging original");
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(row.rawContent);
      let canonicalId: string;
      let noteJob: { noteId: string; sourceRevision: string } | null = null;
      if (row.artifactType === "note") {
        const parsed = parseNoteMarkdown(content);
        // Canonical-folder legacy sources must obey the existing ID/date layout.
        const canonicalPath = `notes/${parsed.metadata.captured_at.slice(0, 4)}/${parsed.metadata.captured_at.slice(5, 7)}/${parsed.metadata.id}.md`;
        if (
          row.sourcePath.startsWith("notes/") &&
          row.sourcePath !== canonicalPath
        )
          throw new TypeError("Invalid canonical source path");
        if (!row.sourcePath.startsWith("notes/"))
          verifyInboxNotePath(row.sourcePath, parsed.metadata);
        const existing = await db.note.findUnique({
          where: { id: parsed.metadata.id },
        });
        // Exact-byte, same-owner legacy reconciliation retains the original
        // canonical provenance, user edits and embeddings. Never claim null owners.
        if (
          existing &&
          existing.ownerSubject === ownerSubject &&
          existing.contentHash === row.contentHash &&
          existing.sourceRevision === row.sourceRevision
        ) {
          canonicalId = existing.id;
          noteJob = {
            noteId: existing.id,
            sourceRevision: existing.sourceRevision,
          };
        } else {
          const sourcePath = row.sourcePath.startsWith("notes/")
            ? `inbox/${parsed.metadata.captured_at.slice(0, 10)}_${parsed.metadata.id}.md`
            : row.sourcePath;
          const result = await createNoteRepository(db).importMarkdown({
            markdown: content,
            sourcePath,
            sourceRevision: row.sourceRevision,
            ownerSubject,
          });
          canonicalId = result.noteId;
          noteJob = { noteId: canonicalId, sourceRevision: row.sourceRevision };
        }
      } else if (row.artifactType === "task") {
        const result = await createTaskExtractionRepository(db).importByOwner(
          ownerSubject,
          content,
          row.sourcePath,
          row.sourceRevision,
        );
        canonicalId = result.batchId;
      } else if (row.artifactType === "research") {
        const result = await createResearchRepository(db).importByOwner(
          ownerSubject,
          content,
          row.sourcePath,
          row.sourceRevision,
        );
        canonicalId = result.reportId;
        const parent = await db.note.findFirstOrThrow({
          where: { id: result.parentNoteId, ownerSubject },
          select: { sourceRevision: true },
        });
        noteJob = {
          noteId: result.parentNoteId,
          sourceRevision: parent.sourceRevision,
        };
      } else throw new TypeError("Invalid staging artifact type");
      await options.afterPersist?.();
      await db.$transaction(async (tx) => {
        const acknowledged = await tx.ingestionStaging.updateMany({
          where: fence(),
          data: {
            status: "PROCESSED",
            processedAt: now(),
            canonicalId,
            leaseOwner: null,
            leaseUntil: null,
            nextRetryAt: null,
            lastErrorCode: null,
          },
        });
        if (acknowledged.count !== 1) throw new Error("Staging lease lost");
        if (noteJob)
          await tx.dbProcessingJob.upsert({
            where: { noteId_sourceRevision: noteJob },
            create: { ...noteJob, ownerSubject },
            update: {},
          });
      });
      report.processed++;
    } catch (error) {
      const invalid =
        error instanceof NoteValidationError ||
        error instanceof ProjectionConflictError ||
        error instanceof TypeError ||
        (error instanceof Error &&
          ["ZodError", "TaskConflict"].includes(error.name));
      const changed = await db.ingestionStaging.updateMany({
        where: fence(),
        data: {
          status: invalid ? "INVALID" : "RETRY",
          leaseOwner: null,
          leaseUntil: null,
          nextRetryAt: invalid
            ? null
            : new Date(
                now().getTime() +
                  Math.min(
                    3600000,
                    5000 * 2 ** Math.min(row.attemptCount - 1, 10),
                  ),
              ),
          lastErrorCode: invalid
            ? "INVALID_OR_CONFLICTING_ARTIFACT"
            : "DEPENDENCY_OR_DATABASE_UNAVAILABLE",
        },
      });
      if (changed.count) {
        if (invalid) report.invalid++;
        else report.retried++;
      }
    }
  }
  return report;
}
