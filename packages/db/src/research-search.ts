import { Prisma, type PrismaClient } from "@prisma/client";
import { CHUNKER_VERSION } from "@pce/core";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embedding-jobs.js";
import {
  validOwner,
  validQueryVector,
  SEARCH_MAX_DISTANCE,
} from "./search-ranking.js";
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
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout','2000',true)`;
        return tx.$queryRaw<SearchRow[]>(Prisma.sql`
     WITH filtered AS NOT MATERIALIZED (
      SELECT r.*,n.tags,n.projects,n.kind,${effectiveTagsSql} AS "effectiveTags",
       r.artifact->>'findings' AS findings
      FROM research_reports r JOIN notes n ON n.id=r."parentNoteId" AND n."ownerSubject"=r."ownerSubject"
      LEFT JOIN note_tag_overrides o ON o."noteId"=n.id AND o."ownerSubject"=n."ownerSubject"
      WHERE r."ownerSubject"=${owner}
       ${input.tags?.length ? Prisma.sql`AND ${effectiveTagsSql} @> ${input.tags}::text[]` : Prisma.empty}
       ${input.project ? Prisma.sql`AND ${input.project}=ANY(n.projects)` : Prisma.empty}
       ${input.kind ? Prisma.sql`AND n.kind=${input.kind}` : Prisma.empty}
       ${input.start ? Prisma.sql`AND r."researchedAt">=${new Date(input.start)}` : Prisma.empty}
       ${input.end ? Prisma.sql`AND r."researchedAt"<${new Date(input.end)}` : Prisma.empty}
     ), documents AS (
      SELECT f.*,to_tsvector('simple',f.title||' '||f.findings||' '||coalesce(f.artifact->>'question','')||' '||coalesce((f.artifact->'claims')::text,'')) AS document FROM filtered f
     ), lexical AS (
      SELECT id,row_number() OVER(ORDER BY ts_rank(document,plainto_tsquery('simple',${input.query})) DESC,id) AS rank
      FROM documents WHERE document @@ plainto_tsquery('simple',${input.query}) OR strpos(lower(title||' '||findings),lower(${input.query}))>0
      ORDER BY rank LIMIT 200
     ), distances AS (
      ${
        literal
          ? Prisma.sql`SELECT f.id,min(e.vector <=> ${literal}::vector) AS distance FROM filtered f
       JOIN research_chunks c ON c."reportId"=f.id AND c."ownerSubject"=f."ownerSubject"
       JOIN research_embeddings e ON e."chunkId"=c.id
       WHERE c."ownerSubject"=${owner} AND c."reportContentHash"=f."contentHash"
        AND c."chunkerVersion"=${CHUNKER_VERSION} AND e.provider='openai'
        AND e."modelId"=${EMBEDDING_MODEL} AND e.dimensions=${EMBEDDING_DIMENSIONS}
        AND e.status='READY' AND e.vector IS NOT NULL GROUP BY f.id`
          : Prisma.sql`SELECT id,0.0::double precision AS distance FROM filtered WHERE false`
      }
     ), semantic AS (SELECT id,row_number() OVER(ORDER BY distance,id) AS rank FROM distances WHERE distance<${SEARCH_MAX_DISTANCE} ORDER BY distance,id LIMIT 200),
     ranked AS (SELECT coalesce(l.id,s.id) AS id,l.id IS NOT NULL AS lexical,s.id IS NOT NULL AS semantic,
      coalesce(1.0/(60+l.rank),0)+coalesce(1.0/(60+s.rank),0) AS score FROM lexical l FULL JOIN semantic s ON l.id=s.id)
     SELECT f.id,f.title,left(f.findings,240) AS snippet,f."researchedAt" AS "capturedAt",f."sourceRevision",
       f.origin AS channel,f."effectiveTags" AS tags,f.projects,f.kind,r.lexical,r.semantic,
       'research' AS "contentType",f."parentNoteId",r.score::double precision AS score
     FROM ranked r JOIN filtered f ON f.id=r.id ORDER BY r.score DESC,f."researchedAt" DESC,f.id LIMIT 201`);
      });
    },
  };
}
