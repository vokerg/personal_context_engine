import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { parseNoteMarkdown, verifyInboxNotePath } from "@pce/core";

export { PrismaClient } from "@prisma/client";
export { createTagFacetRepository, TAG_FACET_LIMIT } from "./tags.js";
export {
  createNoteTagRepository,
  effectiveTagsSql,
  NoteTagConflictError,
} from "./note-tags.js";
export {
  createTagRegistryRepository,
  APPROVED_TAG_LIMIT,
} from "./tag-registry.js";
export { createLexicalSearchRepository } from "./lexical-search.js";
export { createNoteChunkRepository } from "./chunks.js";
export {
  createEmbeddingJobRepository,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_TOKEN_RESERVATION,
  EMBEDDING_DAILY_TOKEN_LIMIT,
} from "./embedding-jobs.js";
export type { EmbeddingJob, EmbeddingFailureCode } from "./embedding-jobs.js";

export type ProjectionConflictCode =
  | "CAPTURE_CONFLICT"
  | "SOURCE_CONFLICT"
  | "REVISION_CONFLICT"
  | "OWNER_CONFLICT";

export class ProjectionConflictError extends Error {
  constructor(public readonly code: ProjectionConflictCode) {
    super("Projection conflict: " + code);
    this.name = "ProjectionConflictError";
  }
}

export interface ImportMarkdownInput {
  /** Original, validated-by-the-repository Markdown bytes, not an LLM interpretation. */
  markdown: string;
  /** Explicit trusted import owner; absent for legacy unowned projections. */
  ownerSubject?: string;
  /** Canonical inbox locator; never a user-selected filesystem path. */
  sourcePath: string;
  /** Opaque, immutable revision supplied by a ContentStore adapter. */
  sourceRevision: string;
  /** Required to change an existing note's source revision. */
  expectedPreviousRevision?: string;
}

export type ImportOutcome = {
  noteId: string;
  result: "created" | "replayed" | "updated";
};

/** Used only by trusted server components; does not authorize a private HTTP route. */
export function createDatabaseClient(): PrismaClient {
  return new PrismaClient();
}

export async function checkDatabase(client: PrismaClient): Promise<boolean> {
  await client.$queryRaw`SELECT 1`;
  return true;
}

function retryable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034")
  );
}

/**
 * Durable projection, with serializable transaction and bounded replay on
 * uniqueness/serialization races. Storage finalization stays in issue #10.
 * Failures never delete or move Markdown.
 */
export function createNoteRepository(client: PrismaClient) {
  return {
    async importMarkdown(input: ImportMarkdownInput): Promise<ImportOutcome> {
      if (
        input.ownerSubject !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(input.ownerSubject)
      ) {
        throw new ProjectionConflictError("OWNER_CONFLICT");
      }
      const note = parseNoteMarkdown(input.markdown);
      const meta = note.metadata;
      verifyInboxNotePath(input.sourcePath, meta);
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.sourceRevision) ||
        (input.expectedPreviousRevision !== undefined &&
          !/^[A-Za-z0-9_-]{1,128}$/.test(input.expectedPreviousRevision))
      ) {
        throw new ProjectionConflictError("REVISION_CONFLICT");
      }
      const contentHash = createHash("sha256")
        .update(input.markdown, "utf8")
        .digest("hex");
      const capturedAt = new Date(meta.captured_at);
      const fields = {
        captureId: meta.capture_id,
        schemaVersion: meta.schema_version,
        capturedAt,
        capturedAtRaw: meta.captured_at,
        source: meta.source,
        title: meta.title,
        kind: meta.kind,
        domains: meta.domains,
        projects: meta.projects,
        tags: meta.tags,
        relatedNoteIds: meta.related_note_ids ?? [],
        actionHint: meta.action_hint,
        reviewRequired: meta.review_required,
        occurredAt: meta.occurred_at ? new Date(meta.occurred_at) : null,
        occurredAtRaw: meta.occurred_at ?? null,
        dueAt: meta.due_at ? new Date(meta.due_at) : null,
        dueAtRaw: meta.due_at ?? null,
        timezone: meta.timezone ?? null,
        processingModel: meta.processing_model ?? null,
        summary: note.summary,
        body: note.body,
        originalInput: note.originalInput,
        sourcePath: input.sourcePath,
        sourceRevision: input.sourceRevision,
        contentHash,
      };

      for (let retry = 0; retry < 6; retry++) {
        try {
          return await client.$transaction(
            async (tx): Promise<ImportOutcome> => {
              const existingCapture = await tx.capture.findUnique({
                where: { id: meta.capture_id },
              });
              if (existingCapture) {
                const captureOwners = await tx.note.findMany({
                  where: { captureId: meta.capture_id },
                  select: { ownerSubject: true },
                });
                if (
                  captureOwners.some(
                    (row) => row.ownerSubject !== (input.ownerSubject ?? null),
                  )
                )
                  throw new ProjectionConflictError("OWNER_CONFLICT");
                if (
                  existingCapture.capturedAtRaw !== meta.captured_at ||
                  existingCapture.source !== meta.source ||
                  existingCapture.timezone !== (meta.timezone ?? null)
                ) {
                  throw new ProjectionConflictError("CAPTURE_CONFLICT");
                }
              } else {
                // Original input of every split note remains on its own Note;
                // the Capture retains the first imported segment as well.
                await tx.capture.create({
                  data: {
                    id: meta.capture_id,
                    capturedAt,
                    capturedAtRaw: meta.captured_at,
                    source: meta.source,
                    timezone: meta.timezone ?? null,
                    originalInput: note.originalInput,
                  },
                });
              }

              const existing = await tx.note.findUnique({
                where: { id: meta.id },
              });
              if (!existing) {
                await tx.note.create({
                  data: {
                    id: meta.id,
                    ownerSubject: input.ownerSubject ?? null,
                    ...fields,
                  },
                });
                return { noteId: meta.id, result: "created" };
              }
              if (existing.ownerSubject !== (input.ownerSubject ?? null)) {
                throw new ProjectionConflictError("OWNER_CONFLICT");
              }
              if (
                existing.captureId !== meta.capture_id ||
                existing.sourcePath !== input.sourcePath
              ) {
                throw new ProjectionConflictError("SOURCE_CONFLICT");
              }
              if (existing.sourceRevision === input.sourceRevision) {
                if (existing.contentHash !== contentHash) {
                  throw new ProjectionConflictError("REVISION_CONFLICT");
                }
                return { noteId: meta.id, result: "replayed" };
              }
              if (
                !input.expectedPreviousRevision ||
                existing.sourceRevision !== input.expectedPreviousRevision
              ) {
                throw new ProjectionConflictError("REVISION_CONFLICT");
              }
              const changed = await tx.note.updateMany({
                where: {
                  id: meta.id,
                  sourceRevision: input.expectedPreviousRevision,
                },
                data: { ...fields, state: "PERSISTED", canonicalPath: null },
              });
              if (changed.count !== 1) {
                throw new ProjectionConflictError("REVISION_CONFLICT");
              }
              // Every revision replacement invalidates derived text and vectors
              // atomically; repeated imports above leave them untouched.
              await tx.noteChunk.deleteMany({ where: { noteId: meta.id } });
              return { noteId: meta.id, result: "updated" };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          if (retryable(error) && retry < 5) continue;
          if (retryable(error))
            throw new ProjectionConflictError("SOURCE_CONFLICT");
          throw error;
        }
      }
      throw new ProjectionConflictError("SOURCE_CONFLICT");
    },

    /** Internal server-side read; authorization must be enforced by caller (#13). */
    getNote(noteId: string) {
      return client.note.findUnique({ where: { id: noteId } });
    },
  };
}

export { createBrowseRepository, BrowseCursorError } from "./browse.js";

export { createSessionRepository } from "./session-auth.js";
export type { SessionRepository } from "./session-auth.js";

export { createApiCaptureRepository, CaptureConflict } from "./api-capture.js";

export { createSearchRepository } from "./search.js";
export type { SearchRepository } from "./search.js";

export { createSearchDiagnosticsRepository } from "./search-diagnostics.js";
export type {
  IndexHealth,
  RankingDiagnostic,
  ChunkDiagnostic,
} from "./search-diagnostics.js";

export { SEARCH_COSINE_THRESHOLD, SEARCH_RRF_K } from "./search-ranking.js";
