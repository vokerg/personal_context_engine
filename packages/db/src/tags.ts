import { Prisma, type PrismaClient } from "@prisma/client";

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
    async listTagsByOwner(owner: string) {
      if (allowedIds?.length === 0) return { tags: [], truncated: false };
      const snapshot = allowedIds
        ? Prisma.sql`AND n.id IN (${Prisma.join(allowedIds)})`
        : Prisma.empty;
      const rows = await client.$queryRaw<Array<{ slug: string; noteCount: bigint }>>(
        Prisma.sql`
          SELECT t.slug AS "slug", COUNT(DISTINCT n.id)::bigint AS "noteCount"
          FROM notes AS n CROSS JOIN LATERAL unnest(n.tags) AS t(slug)
          WHERE n."ownerSubject" = ${owner} ${snapshot}
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
