import { Prisma, type PrismaClient } from "@prisma/client";
import { CHUNKER_VERSION } from "@pce/core";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embedding-jobs.js";
import {
  validOwner,
  validQueryVector,
  SEARCH_MAX_DISTANCE,
  SEARCH_RRF_K,
} from "./search-ranking.js";
import {
  identifierPredicate,
  lexicalDocuments,
  lexicalMatch,
  lexicalQueries,
  lexicalScore,
  keywordAnchor,
  keywordAdmission,
} from "./search-lexical.js";
import { effectiveTagsSql } from "./note-tags.js";
import type { SearchInput, SearchRow } from "./search.js";

export function createResearchSearchRepository(db: PrismaClient) {
  return {
    async hasIndex(owner: string) {
      validOwner(owner);
      const [row] = await db.$queryRaw<Array<{ present: boolean }>>`
       SELECT EXISTS(SELECT 1 FROM research_embeddings e JOIN research_chunks c ON c.id=e."chunkId"
        JOIN research_reports r ON r.id=c."reportId" AND r."ownerSubject"=c."ownerSubject"
        WHERE c."ownerSubject"=${owner} AND c."reportContentHash"=r."contentHash"
         AND c."chunkerVersion"=${CHUNKER_VERSION} AND e.provider='openai' AND e."modelId"=${EMBEDDING_MODEL}
         AND e.dimensions=${EMBEDDING_DIMENSIONS} AND e.status='READY' AND e.vector IS NOT NULL) AS present`;
      return row?.present === true;
    },
    async searchByOwner(
      owner: string,
      input: SearchInput,
      vector?: number[],
    ): Promise<SearchRow[]> {
      validOwner(owner);
      if (
        !input.query.trim() ||
        input.query.length > 500 ||
        (vector && !validQueryVector(vector))
      )
        throw new TypeError("Invalid research query");
      const literal = vector ? "[" + vector.join(",") + "]" : null;
      const text = Prisma.sql`title||' '||findings||' '||coalesce(artifact->>'question','')||' '||coalesce((artifact->'claims')::text,'')`;
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout','2000',true)`;
        return tx.$queryRaw<SearchRow[]>(Prisma.sql`
     WITH ${lexicalQueries(input.query)}, filtered AS NOT MATERIALIZED (
      SELECT r.*,n.tags,n.projects,n.kind,n."archivedAt" AS "archivedAt",${effectiveTagsSql} AS "effectiveTags",
       r.artifact->>'findings' AS findings
      FROM research_reports r JOIN notes n ON n.id=r."parentNoteId" AND n."ownerSubject"=r."ownerSubject"
      LEFT JOIN note_tag_overrides o ON o."noteId"=n.id AND o."ownerSubject"=n."ownerSubject"
      WHERE r."ownerSubject"=${owner} AND n."removedAt" IS NULL
       ${input.status === "active" ? Prisma.sql`AND n."archivedAt" IS NULL` : input.status === "archived" ? Prisma.sql`AND n."archivedAt" IS NOT NULL` : Prisma.empty}
       ${input.tags?.length ? Prisma.sql`AND ${effectiveTagsSql} @> ${input.tags}::text[]` : Prisma.empty}
       ${input.project ? Prisma.sql`AND ${input.project}=ANY(n.projects)` : Prisma.empty}
       ${input.kind ? Prisma.sql`AND n.kind=${input.kind}` : Prisma.empty}
       ${input.start ? Prisma.sql`AND r."researchedAt">=${new Date(input.start)}` : Prisma.empty}
       ${input.end ? Prisma.sql`AND r."researchedAt"<${new Date(input.end)}` : Prisma.empty}
     ), documents AS (
      SELECT f.*,${lexicalDocuments(Prisma.sql`title`, text)} FROM filtered f
      WHERE ${identifierPredicate(input.query, text)}
     ), lexical AS (
      SELECT id,${literal ? lexicalMatch(input.query, text, true) : Prisma.sql`true`} AS vote,
      row_number() OVER(ORDER BY
       ${lexicalMatch(input.query, text, true)} DESC,
       (lower(title)=lower(${input.query})) DESC,
       (strpos(lower(title),lower(${input.query}))>0) DESC,
       ${lexicalScore} DESC,id COLLATE "C") AS rank
      FROM documents CROSS JOIN search_query q WHERE ${lexicalMatch(input.query, text, false)}
      ORDER BY rank LIMIT 200
     ), distances AS (
      ${
        literal
          ? Prisma.sql`SELECT f.id,min(e.vector <=> ${literal}::vector) AS distance FROM documents f
       JOIN research_chunks c ON c."reportId"=f.id AND c."ownerSubject"=f."ownerSubject"
       JOIN research_embeddings e ON e."chunkId"=c.id
       WHERE c."ownerSubject"=${owner} AND c."reportContentHash"=f."contentHash"
        AND c."chunkerVersion"=${CHUNKER_VERSION} AND e.provider='openai'
        AND e."modelId"=${EMBEDDING_MODEL} AND e.dimensions=${EMBEDDING_DIMENSIONS}
        AND e.status='READY' AND e.vector IS NOT NULL GROUP BY f.id`
          : Prisma.sql`SELECT id,0.0::double precision AS distance FROM documents WHERE false`
      }
     ), ${keywordAnchor(input.query, "documents", SEARCH_MAX_DISTANCE)},
     semantic AS (SELECT d.id,row_number() OVER(ORDER BY d.distance,d.id) AS rank
       FROM distances d CROSS JOIN keyword_anchor a WHERE d.distance<${SEARCH_MAX_DISTANCE} AND ${keywordAdmission}
       ORDER BY d.distance,d.id LIMIT 200),
     ranked AS (SELECT coalesce(l.id,s.id) AS id,l.id IS NOT NULL AS lexical,s.id IS NOT NULL AS semantic,
      CASE WHEN l.vote THEN 1.0/(${SEARCH_RRF_K}+l.rank) ELSE 0 END+coalesce(1.0/(${SEARCH_RRF_K}+s.rank),0) AS score FROM lexical l FULL JOIN semantic s ON l.id=s.id)
     SELECT f.id,f.title,left(f.findings,240) AS snippet,f."researchedAt" AS "capturedAt",f."sourceRevision",
       f.origin AS channel,f."effectiveTags" AS tags,f.projects,f.kind,
       CASE WHEN f."archivedAt" IS NULL THEN 'active' ELSE 'archived' END AS status,
       r.lexical,r.semantic,
       'research' AS "contentType",f."parentNoteId",r.score::double precision AS score
     FROM ranked r JOIN filtered f ON f.id=r.id ORDER BY r.score DESC,f."researchedAt" DESC,f.id LIMIT 201`);
      });
    },
  };
}
