import type { PrismaClient } from "@prisma/client";

const validOwner = (owner: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(owner))
    throw new TypeError("Invalid verified owner");
};
const validId = (id: string) => {
  if (
    !/^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(
      id,
    )
  )
    throw new TypeError("Invalid note id");
};

export type NoteArchiveStatus = "active" | "archived";

/** Owner-scoped, reversible archive state; removal always takes precedence. */
export function createNoteArchiveRepository(db: PrismaClient) {
  return {
    async setArchivedByOwner(
      owner: string,
      noteId: string,
      archived: boolean,
      at = new Date(),
    ): Promise<NoteArchiveStatus | null> {
      validOwner(owner);
      validId(noteId);
      if (!(at instanceof Date) || Number.isNaN(at.getTime()))
        throw new TypeError("Invalid archive timestamp");
      const note = await db.note.findFirst({
        where: { id: noteId, ownerSubject: owner, removedAt: null },
        select: { archivedAt: true },
      });
      if (!note) return null;
      const currentlyArchived = note.archivedAt !== null;
      if (currentlyArchived === archived)
        return currentlyArchived ? "archived" : "active";
      const result = await db.note.updateMany({
        where: {
          id: noteId,
          ownerSubject: owner,
          removedAt: null,
          ...(currentlyArchived
            ? { archivedAt: { not: null } }
            : { archivedAt: null }),
        },
        data: archived
          ? { archivedAt: at, archivedBy: owner }
          : { archivedAt: null, archivedBy: null },
      });
      return result.count === 1 ? (archived ? "archived" : "active") : null;
    },
  };
}
