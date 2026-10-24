import { Prisma, PrismaClient } from "@prisma/client";
import { CHUNKER_VERSION, ChunkLimitError, chunkNoteText } from "@pce/core";

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;

export type ChunkSyncResult =
  | { status: "missing" | "oversized"; count: 0 }
  | { status: "unchanged" | "synchronized"; count: number };

type LockedNote = {
  id: string;
  ownerSubject: string;
  sourceRevision: string;
  contentHash: string;
  originalInput: string;
  summary: string;
  body: string;
  removedAt: Date | null;
};

function validOwner(ownerSubject: string): void {
  if (!OWNER_PATTERN.test(ownerSubject)) {
    throw new TypeError("Invalid verified owner subject");
  }
}

/**
 * Server-only, manually invoked index preparation. Not an embedding worker:
 * does not create provider jobs, perform model calls or run on import.
 * A note-row lock serializes preparation with a concurrent source update.
 */
export function createNoteChunkRepository(client: PrismaClient) {
  return {
    async sync(noteId: string, ownerSubject: string): Promise<ChunkSyncResult> {
      validOwner(ownerSubject);
      return client.$transaction(
        async (tx): Promise<ChunkSyncResult> => {
          const rows = await tx.$queryRaw<LockedNote[]>`
            SELECT "id", "ownerSubject", "sourceRevision", "contentHash",
                   "originalInput", "summary", "body", "removedAt"
            FROM "notes"
            WHERE "id" = ${noteId} AND "ownerSubject" = ${ownerSubject}
            FOR UPDATE
          `;
          const note = rows[0];
          if (!note || note.removedAt) return { status: "missing", count: 0 };

          let draft;
          try {
            draft = chunkNoteText({
              noteId: note.id,
              originalInput: note.originalInput,
              summary: note.summary,
              body: note.body,
            });
          } catch (error) {
            if (error instanceof ChunkLimitError) {
              return { status: "oversized", count: 0 };
            }
            throw error;
          }

          const existing = await tx.noteChunk.findMany({
            where: { noteId, ownerSubject },
            select: {
              id: true,
              sourceRevision: true,
              noteContentHash: true,
              chunkerVersion: true,
              section: true,
              ordinal: true,
              startOffset: true,
              endOffset: true,
              contentHash: true,
            },
          });
          const byId = new Map(existing.map((chunk) => [chunk.id, chunk]));
          const unchanged =
            existing.length === draft.length &&
            draft.every((chunk) => {
              const old = byId.get(chunk.id);
              return (
                old?.sourceRevision === note.sourceRevision &&
                old.noteContentHash === note.contentHash &&
                old.chunkerVersion === CHUNKER_VERSION &&
                old.section === chunk.section &&
                old.ordinal === chunk.ordinal &&
                old.startOffset === chunk.startOffset &&
                old.endOffset === chunk.endOffset &&
                old.contentHash === chunk.contentHash
              );
            });
          if (unchanged) return { status: "unchanged", count: draft.length };

          // CAS semantics are enforced by the locked note row. Cascade
          // deletes all vectors before any changed source can be searchable.
          await tx.noteChunk.deleteMany({ where: { noteId, ownerSubject } });
          if (draft.length > 0) {
            await tx.noteChunk.createMany({
              data: draft.map((chunk) => ({
                ...chunk,
                noteId,
                ownerSubject,
                sourceRevision: note.sourceRevision,
                noteContentHash: note.contentHash,
                chunkerVersion: CHUNKER_VERSION,
              })),
            });
          }
          return { status: "synchronized", count: draft.length };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    },

    /** Scoped read of current-version chunks only; the DB FK also enforces ownership. */
    listCurrentByOwner(noteId: string, ownerSubject: string) {
      validOwner(ownerSubject);
      return client.noteChunk.findMany({
        where: {
          noteId,
          ownerSubject,
          chunkerVersion: CHUNKER_VERSION,
          note: { ownerSubject, removedAt: null },
        },
        orderBy: [{ section: "asc" }, { ordinal: "asc" }],
        take: 512,
      });
    },

    /** Bounded keyset scan for a later opt-in, resumable backfill driver (#47). */
    async backfillPage(
      ownerSubject: string,
      afterNoteId?: string,
      requestedLimit = 50,
    ): Promise<string[]> {
      validOwner(ownerSubject);
      const limit = Number.isInteger(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 100))
        : 50;
      const notes = await client.note.findMany({
        where: {
          ownerSubject,
          removedAt: null,
          ...(afterNoteId ? { id: { gt: afterNoteId } } : {}),
        },
        orderBy: { id: "asc" },
        select: { id: true },
        take: limit,
      });
      return notes.map((note) => note.id);
    },
  };
}
