import { Prisma, type PrismaClient } from "@prisma/client";
import { effectiveTagsSql } from "./note-tags.js";

/** Explicit, public wire-contract limit for the observed tag catalog. */
export const TAG_FACET_LIMIT = 200;

/**
 * Count distinct notes within an SQL owner predicate. The optional snapshot
 * predicate prevents deleted/absent checkout files from appearing in local UX.
 */
export function createTagFacetRepository(
  client: PrismaClient,
  allowedIds?: readonly string[],
) {
  return {
    async listTagsByOwner(
      owner: string,
      status: "active" | "archived" | "all" = "active",
    ) {
      if (allowedIds?.length === 0) return { tags: [], truncated: false };
      const snapshot = allowedIds
        ? Prisma.sql`AND n.id IN (${Prisma.join(allowedIds)})`
        : Prisma.empty;
      const rows = await client.$queryRaw<
        Array<{ slug: string; noteCount: bigint }>
      >(
        Prisma.sql`
          SELECT t.slug AS "slug", COUNT(DISTINCT n.id)::bigint AS "noteCount"
          FROM notes AS n
          LEFT JOIN note_tag_overrides o ON o."noteId"=n.id AND o."ownerSubject"=n."ownerSubject"
          CROSS JOIN LATERAL unnest(${effectiveTagsSql}) AS t(slug)
          WHERE n."ownerSubject" = ${owner}
            AND n."removedAt" IS NULL
            ${status === "active" ? Prisma.sql`AND n."archivedAt" IS NULL` : status === "archived" ? Prisma.sql`AND n."archivedAt" IS NOT NULL` : Prisma.empty}
            ${snapshot}
          GROUP BY t.slug
          ORDER BY t.slug COLLATE "C" ASC
          LIMIT ${TAG_FACET_LIMIT + 1}
        `,
      );
      return {
        tags: rows.slice(0, TAG_FACET_LIMIT).map(({ slug, noteCount }) => ({
          slug,
          count: Number(noteCount),
        })),
        truncated: rows.length > TAG_FACET_LIMIT,
      };
    },
  };
}
