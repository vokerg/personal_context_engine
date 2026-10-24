import type { PrismaClient } from "@prisma/client";

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;
const NOTE_ID_PATTERN =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

function validate(owner: string, noteId: string): void {
  if (!OWNER_PATTERN.test(owner) || !NOTE_ID_PATTERN.test(noteId))
    throw new TypeError("Invalid note removal scope");
}

/**
 * Hide a note from normal owner-scoped product reads without deleting its
 * immutable source projection, capture or provenance. The null predicate makes
 * repeated removal idempotent and prevents a stale request from changing the
 * removal actor or timestamp.
 */
export function createNoteRemovalRepository(db: PrismaClient) {
  return {
    async removeByOwner(
      owner: string,
      noteId: string,
      removedAt = new Date(),
    ): Promise<boolean> {
      validate(owner, noteId);
      if (Number.isNaN(removedAt.getTime()))
        throw new TypeError("Invalid removal timestamp");
      const result = await db.note.updateMany({
        where: { id: noteId, ownerSubject: owner, removedAt: null },
        data: { removedAt, removedBy: owner },
      });
      return result.count === 1;
    },
  };
}
