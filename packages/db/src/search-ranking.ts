import { Prisma } from "@prisma/client";
import { CHUNKER_VERSION } from "@pce/core";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embedding-jobs.js";
import type { SearchInput } from "./search.js";
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

export const currentChunk = (alias: "n" | "f" = "n") => {
  const note = Prisma.raw(alias); // Fixed SQL aliases only, never caller input.
  return Prisma.sql`c."sourceRevision"=${note}."sourceRevision" AND c."noteContentHash"=${note}."contentHash" AND c."chunkerVersion"=${CHUNKER_VERSION}`;
};
export const compatibleEmbedding = Prisma.sql`e.provider='openai' AND e."modelId"=${EMBEDDING_MODEL} AND e.dimensions=${EMBEDDING_DIMENSIONS}`;
export const eligibleEmbedding = (alias: "n" | "f" = "n") =>
  Prisma.sql`${currentChunk(alias)} AND ${compatibleEmbedding} AND e.status='READY' AND e.vector IS NOT NULL`;

export const validOwner = (owner: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(owner))
    throw new TypeError("Invalid verified owner");
};
export const SEARCH_RANKING_VERSION = "multilingual-keyword-v3";
export const SEARCH_COSINE_THRESHOLD = 0.15;
export const SEARCH_MAX_DISTANCE = 1 - SEARCH_COSINE_THRESHOLD;
export const SEARCH_RRF_K = 60;
export const validQueryVector = (vector: number[]) =>
  vector.length === EMBEDDING_DIMENSIONS &&
  vector.every(Number.isFinite) &&
  vector.some((v) => v !== 0);
/** Shared production eligibility and ranking CTEs; diagnostics only add projections. */
export function searchRanking(
  owner: string,
  input: SearchInput,
  literal: string | null,
) {
  const filter = Prisma.sql`n."ownerSubject"=${owner} AND n."removedAt" IS NULL
    ${input.status === "active" ? Prisma.sql`AND n."archivedAt" IS NULL` : input.status === "archived" ? Prisma.sql`AND n."archivedAt" IS NOT NULL` : Prisma.empty}
    ${input.tags?.length ? Prisma.sql`AND ${effectiveTagsSql} @> ${input.tags}::text[]` : Prisma.empty}
    ${input.project ? Prisma.sql`AND ${input.project}=ANY(n.projects)` : Prisma.empty}
    ${input.kind ? Prisma.sql`AND n.kind=${input.kind}` : Prisma.empty}
    ${input.start ? Prisma.sql`AND n."capturedAt">=${new Date(input.start)}` : Prisma.empty}
    ${input.end ? Prisma.sql`AND n."capturedAt"<${new Date(input.end)}` : Prisma.empty}`;
  const text = Prisma.sql`n.title||E'\n'||n.summary||E'\n'||n.body||E'\n'||n."originalInput"`;
  const filteredText = Prisma.sql`title||E'\n'||summary||E'\n'||body||E'\n'||"originalInput"`;
  return Prisma.sql`WITH ${lexicalQueries(input.query)}, filtered AS NOT MATERIALIZED (
       SELECT n.*,${effectiveTagsSql} AS "effectiveTags",${lexicalDocuments(Prisma.sql`n.title`, text, Prisma.sql`n.summary`, Prisma.sql`n.body`)}
       FROM notes n LEFT JOIN note_tag_overrides o ON o."noteId"=n.id AND o."ownerSubject"=n."ownerSubject"
       WHERE ${filter} AND ${identifierPredicate(input.query, text)}
     ), lexical AS (
       SELECT id,${literal ? lexicalMatch(input.query, filteredText, true) : Prisma.sql`true`} AS vote,
       row_number() OVER(ORDER BY
         ${lexicalMatch(input.query, filteredText, true)} DESC,
         (lower(title)=lower(${input.query})) DESC,
         (strpos(lower(title),lower(${input.query}))>0) DESC,
         ${lexicalScore} DESC,"capturedAt" DESC,id COLLATE "C") AS rank
       FROM filtered CROSS JOIN search_query q
       WHERE ${lexicalMatch(input.query, filteredText, false)}
       ORDER BY rank LIMIT 200
     ), distances AS (
       ${
         literal
           ? Prisma.sql`SELECT f.id,min(e.vector <=> ${literal}::vector) AS distance
        FROM filtered f JOIN note_chunks c ON c."noteId"=f.id AND c."ownerSubject"=f."ownerSubject"
        JOIN chunk_embeddings e ON e."chunkId"=c.id
        WHERE c."ownerSubject"=${owner} AND ${eligibleEmbedding("f")}
        GROUP BY f.id`
           : Prisma.sql`SELECT id,0.0::double precision AS distance FROM filtered WHERE false`
       }
     ), ${keywordAnchor(input.query, "filtered", SEARCH_MAX_DISTANCE)},
     semantic AS (SELECT d.id,row_number() OVER(ORDER BY d.distance,d.id COLLATE "C") AS rank
       FROM distances d CROSS JOIN keyword_anchor a
       WHERE d.distance < ${SEARCH_MAX_DISTANCE} AND ${keywordAdmission}
       ORDER BY d.distance,d.id COLLATE "C" LIMIT 200),
     ranked AS (SELECT coalesce(l.id,s.id) AS id,CASE WHEN l.vote THEN 1.0/(${SEARCH_RRF_K}+l.rank) ELSE 0 END+coalesce(1.0/(${SEARCH_RRF_K}+s.rank),0) AS score,
          l.rank::int AS "lexicalRank",s.rank::int AS "semanticRank",coalesce(l.vote,false) AS "lexicalVote",
          l.id IS NOT NULL AS lexical,s.id IS NOT NULL AS semantic
       FROM lexical l FULL JOIN semantic s ON l.id=s.id)`;
}
