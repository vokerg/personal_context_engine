import { Prisma, type PrismaClient } from "@prisma/client";

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;
const NOTE_ID_PATTERN =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TAGS = 100;

/** Requires the trusted n/o LEFT JOIN; used in all tag-sensitive SQL reads. */
export const effectiveTagsSql = Prisma.sql`
  ARRAY(SELECT DISTINCT t.slug
    FROM unnest(n.tags || COALESCE(o.added, ARRAY[]::text[])) t(slug)
    WHERE NOT (t.slug = ANY(COALESCE(o.removed, ARRAY[]::text[])))
    ORDER BY t.slug)
`;

export interface NoteTagEdit {
  operation: "add" | "remove";
  slug: string;
  expectedRevision: number;
}

export class NoteTagConflictError extends Error {
  constructor() {
    super("Stale note tag revision");
    this.name = "NoteTagConflictError";
  }
}

export function effective(
  source: string[],
  added: string[],
  removed: string[],
) {
  const exclusions = new Set(removed);
  return [...new Set([...source, ...added])]
    .filter((tag) => !exclusions.has(tag))
    .sort();
}

/** Owner and note identity are resolved and enforced server-side, never from request payload. */
export function createNoteTagRepository(db: PrismaClient) {
  return {
    async changeByOwner(owner: string, id: string, edit: NoteTagEdit) {
      if (
        !OWNER_PATTERN.test(owner) ||
        !NOTE_ID_PATTERN.test(id) ||
        !SLUG_PATTERN.test(edit.slug) ||
        edit.slug.length > 64 ||
        !["add", "remove"].includes(edit.operation) ||
        !Number.isSafeInteger(edit.expectedRevision) ||
        edit.expectedRevision < 0
      )
        throw new TypeError("Invalid note tag edit");
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await db.$transaction(
            async (tx) => {
              const note = await tx.note.findFirst({
                where: { id, ownerSubject: owner, removedAt: null },
                select: { tags: true },
              });
              if (!note) return null;
              const state = await tx.noteTagOverride.findUnique({
                where: { noteId: id },
              });
              const revision = state?.revision ?? 0;
              if (revision !== edit.expectedRevision)
                throw new NoteTagConflictError();
              let added = state?.added ?? [];
              let removed = state?.removed ?? [];
              const before = effective(note.tags, added, removed);
              if (edit.operation === "add") {
                removed = removed.filter((tag) => tag !== edit.slug);
                if (
                  !note.tags.includes(edit.slug) &&
                  !added.includes(edit.slug)
                )
                  added = [...added, edit.slug];
              } else if (before.includes(edit.slug)) {
                added = added.filter((tag) => tag !== edit.slug);
                // A manual-only addition can simply be undone. Only source
                // tags need persistent tombstones across GitHub re-imports.
                if (note.tags.includes(edit.slug))
                  removed = [...removed, edit.slug];
              }
              const after = effective(note.tags, added, removed);
              if (
                after.length > MAX_TAGS ||
                added.length > MAX_TAGS ||
                removed.length > MAX_TAGS
              )
                throw new TypeError("Too many tag overrides");
              const changed =
                added.join("\u0000") !== (state?.added ?? []).join("\u0000") ||
                removed.join("\u0000") !==
                  (state?.removed ?? []).join("\u0000");
              let next = revision;
              if (changed) {
                if (state) {
                  const result = await tx.noteTagOverride.updateMany({
                    where: { noteId: id, ownerSubject: owner, revision },
                    data: { added, removed, revision: { increment: 1 } },
                  });
                  if (result.count !== 1) throw new NoteTagConflictError();
                } else {
                  await tx.noteTagOverride.create({
                    data: {
                      noteId: id,
                      ownerSubject: owner,
                      added,
                      removed,
                      revision: 1,
                    },
                  });
                }
                next += 1;
              }
              return {
                tags: after,
                tagEditing: {
                  sourceTags: note.tags,
                  manualAdded: added,
                  manualRemoved: removed,
                  revision: next,
                },
                changed,
              };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            ["P2002", "P2034"].includes(error.code) &&
            attempt < 2
          )
            continue;
          throw error;
        }
      }
      throw new Error("Note tag transaction retries exhausted");
    },
  };
}
