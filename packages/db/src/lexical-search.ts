import type { PrismaClient } from "@prisma/client";

/** Server-only fallback over ALL DB originals, including API-origin notes.
 * Callers must supply a verified owner; no provider, chunks or GitHub required.
 * This port does not activate an HTTP route or change ChatGPT search.
 */
export function createLexicalSearchRepository(db: PrismaClient) {
  return {
    async searchByOwner(ownerSubject: string, query: string, limit = 20) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(ownerSubject))
        throw new TypeError("Invalid verified owner subject");
      if (
        !query.trim() ||
        query.length > 500 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        throw new TypeError("Invalid lexical search bounds");
      return db.$queryRaw<
        Array<{
          id: string;
          title: string;
          source: string;
          sourceRevision: string;
          capturedAt: Date;
          snippet: string;
        }>
      >`
        SELECT n."id", n."title", n."source", n."sourceRevision", n."capturedAt",
               left(n."originalInput", 240) AS "snippet"
        FROM "notes" n,
             plainto_tsquery('simple'::regconfig, ${query}) q
        WHERE n."ownerSubject" = ${ownerSubject}
          AND to_tsvector('simple'::regconfig,
                concat_ws(' ', n."title", n."summary", n."body", n."originalInput")) @@ q
        ORDER BY ts_rank(to_tsvector('simple'::regconfig,
                   concat_ws(' ', n."title", n."summary", n."body", n."originalInput")), q) DESC,
                 n."capturedAt" DESC, n."id" ASC
        LIMIT ${limit}
      `;
    },
  };
}
