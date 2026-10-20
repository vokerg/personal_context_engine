import {
  createBrowseRepository,
  createSearchRepository,
  createTagFacetRepository,
  type PrismaClient,
} from "@pce/db";
import {
  BrowsePageSchema,
  BrowseFacetsSchema,
  NoteDetailSchema,
  NotesQuerySchema,
  type BrowseQuery,
} from "@pce/contracts";
import type { PrivateNoteReader } from "./app.js";

/** Trusted server adapter. Every repository query applies the verified owner. */
export function createDatabaseNoteReader(
  db: PrismaClient,
  cursorSecret: string,
): PrivateNoteReader {
  // Hosted originals are DB-owned; no local checkout snapshot is required.
  const browse = createBrowseRepository(db, undefined, cursorSecret);
  const tags = createTagFacetRepository(db);
  const sources = createSearchRepository(db);
  const pageByOwner = async (owner: string, query: BrowseQuery) =>
    BrowsePageSchema.parse(await browse.pageByOwner(owner, query));
  return {
    pageByOwner,
    async facetsByOwner(owner) {
      return BrowseFacetsSchema.parse(await browse.facetsByOwner(owner));
    },
    listTagsByOwner: tags.listTagsByOwner,
    async getByOwner(owner, id) {
      const note = await sources.getByOwner(owner, id);
      return note ? NoteDetailSchema.parse(note) : null;
    },
    async listByOwner(owner, raw = {}) {
      const { from, to, ...filters } = NotesQuerySchema.parse(raw);
      const end = to ? new Date(to + "T00:00:00.000Z") : undefined;
      end?.setUTCDate(end.getUTCDate() + 1);
      // Legacy list is bounded to one page; the hosted web uses pageByOwner.
      return (
        await pageByOwner(owner, {
          ...filters,
          ...(from ? { start: from + "T00:00:00.000Z" } : {}),
          ...(end ? { end: end.toISOString() } : {}),
        })
      ).notes;
    },
  };
}
