import { identifierPredicate } from "./search-lexical.js";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  searchRanking,
  validOwner,
  validQueryVector,
  SEARCH_MAX_DISTANCE,
  currentChunk,
  compatibleEmbedding,
  eligibleEmbedding,
} from "./search-ranking.js";

export interface DiagnosticInput {
  query: string;
  noteId?: string | undefined;
  limit: number;
}
export interface RankingDiagnostic {
  lexicalVote: boolean;
  id: string;
  bestSimilarity: number | null;
  passedThreshold: boolean | null;
  lexicalRank: number | null;
  semanticRank: number | null;
  rrfScore: number;
  finalRank: number | null;
}
export interface IndexHealth {
  totalNotes: number;
  indexedNotes: number;
  fullyIndexedNotes: number;
  coveragePercent: number;
  readyChunks: number;
  missingNotes: number;
  staleChunks: number;
  missingEmbeddings: number;
  incompatibleEmbeddings: number;
  missingVectors: number;
  pending: number;
  leased: number;
  retrying: number;
  failed: number;
}
export interface ChunkDiagnostic {
  id: string;
  section: string;
  ordinal: number;
  sourceRevision: string;
  chunkerVersion: string;
  revisionMatches: boolean;
  hashMatches: boolean;
  current: boolean;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
  status: string | null;
  hasVector: boolean;
  eligible: boolean;
  similarity: number | null;
}
const current = currentChunk();
const compatible = compatibleEmbedding;
const eligible = eligibleEmbedding();

/** No writes, vector projection or source text. Query budget accounting lives in search service. */
export function createSearchDiagnosticsRepository(db: PrismaClient) {
  return {
    async inspectByOwner(
      owner: string,
      input: DiagnosticInput,
      vector?: number[],
    ) {
      validOwner(owner);
      if (
        !input.query.trim() ||
        input.query.length > 500 ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 20 ||
        (input.noteId !== undefined &&
          (input.noteId.length > 36 || !input.noteId.length))
      )
        throw new TypeError("Invalid diagnostics bounds");
      if (vector && !validQueryVector(vector))
        throw new TypeError("Invalid query vector");
      const literal = vector ? `[${vector.join(",")}]` : null;
      return db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$queryRaw`SELECT set_config('statement_timeout','2000',true)`;
          const [health] = await tx.$queryRaw<IndexHealth[]>(Prisma.sql`
          WITH chunks AS (
            SELECT n.id AS "noteId",c.id,e.id AS "embeddingId",(${current}) AS current,
              coalesce((${compatible}),false) AS compatible,coalesce((${eligible}),false) AS eligible,
              e.status,e.vector IS NOT NULL AS "hasVector"
            FROM notes n JOIN note_chunks c ON c."noteId"=n.id AND c."ownerSubject"=n."ownerSubject"
            LEFT JOIN chunk_embeddings e ON e."chunkId"=c.id
            WHERE n."ownerSubject"=${owner} AND n."removedAt" IS NULL AND c."ownerSubject"=${owner}
          ), per_note AS (
            SELECT n.id,coalesce(bool_or(c.eligible),false) AS indexed,
              count(DISTINCT c.id) FILTER(WHERE c.current) AS current_chunks,
              count(DISTINCT c.id) FILTER(WHERE c.eligible) AS ready_chunks
            FROM notes n LEFT JOIN chunks c ON c."noteId"=n.id
            WHERE n."ownerSubject"=${owner} AND n."removedAt" IS NULL GROUP BY n.id
          )
          SELECT count(*)::int AS "totalNotes",count(*) FILTER(WHERE indexed)::int AS "indexedNotes",
            count(*) FILTER(WHERE current_chunks>0 AND current_chunks=ready_chunks)::int AS "fullyIndexedNotes",
            coalesce(round(100.0*count(*) FILTER(WHERE indexed)/nullif(count(*),0),2),0)::float8 AS "coveragePercent",
            count(*) FILTER(WHERE current_chunks=0)::int AS "missingNotes",
            (SELECT count(DISTINCT id)::int FROM chunks WHERE eligible) AS "readyChunks",
            (SELECT count(DISTINCT id)::int FROM chunks WHERE NOT current) AS "staleChunks",
            (SELECT count(DISTINCT id)::int FROM chunks WHERE current AND NOT EXISTS (
              SELECT 1 FROM chunk_embeddings e WHERE e."chunkId"=chunks.id AND ${compatible}
            )) AS "missingEmbeddings",
            (SELECT count(*)::int FROM chunks WHERE current AND "embeddingId" IS NOT NULL AND NOT compatible) AS "incompatibleEmbeddings",
            (SELECT count(*)::int FROM chunks WHERE current AND compatible AND status='READY' AND NOT "hasVector") AS "missingVectors",
            (SELECT count(*)::int FROM chunks WHERE current AND compatible AND status='PENDING') AS pending,
            (SELECT count(*)::int FROM chunks WHERE current AND compatible AND status='LEASED') AS leased,
            (SELECT count(*)::int FROM chunks WHERE current AND compatible AND status='RETRY') AS retrying,
            (SELECT count(*)::int FROM chunks WHERE current AND compatible AND status='FAILED') AS failed
          FROM per_note`);
          const rankings = await tx.$queryRaw<RankingDiagnostic[]>(Prisma.sql`
          ${searchRanking(owner, input, literal)},
          final AS (SELECT r.*,row_number() OVER(ORDER BY score DESC,f."capturedAt" DESC,f.id COLLATE "C")::int AS "finalRank"
            FROM ranked r JOIN filtered f ON f.id=r.id),
          candidates AS (
            SELECT f.id,${literal ? Prisma.sql`1-d.distance` : Prisma.sql`NULL::float8`} AS "bestSimilarity",
              ${literal ? Prisma.sql`CASE WHEN d.distance IS NULL THEN NULL ELSE d.distance<${SEARCH_MAX_DISTANCE} END` : Prisma.sql`NULL::boolean`} AS "passedThreshold",
              coalesce(r."lexicalVote",false) AS "lexicalVote",r."lexicalRank",r."semanticRank",coalesce(r.score,0)::float8 AS "rrfScore",r."finalRank"
            FROM filtered f LEFT JOIN distances d ON d.id=f.id LEFT JOIN final r ON r.id=f.id
          ), selected AS (
            (SELECT * FROM candidates WHERE "finalRank" IS NOT NULL ORDER BY "finalRank",id COLLATE "C" LIMIT ${input.limit})
            UNION
            (SELECT * FROM candidates WHERE "lexicalRank"<=${input.limit})
            UNION
            (SELECT * FROM candidates WHERE "bestSimilarity" IS NOT NULL ORDER BY "bestSimilarity" DESC,id COLLATE "C" LIMIT ${input.limit})
            UNION
            (SELECT * FROM candidates WHERE "passedThreshold"=false ORDER BY "bestSimilarity" DESC,id COLLATE "C" LIMIT 3)
            UNION
            (SELECT * FROM candidates WHERE id=${input.noteId ?? null})
          ) SELECT * FROM selected ORDER BY "finalRank" NULLS LAST,"bestSimilarity" DESC NULLS LAST,id COLLATE "C"`);
          const notes = input.noteId
            ? await tx.$queryRaw<
                Array<{
                  id: string;
                  sourceRevision: string;
                  matchesIdentifiers: boolean;
                }>
              >(Prisma.sql`
              SELECT n.id,n."sourceRevision",${identifierPredicate(input.query, Prisma.sql`n.title||E'\n'||n.summary||E'\n'||n.body||E'\n'||n."originalInput"`)} AS "matchesIdentifiers"
              FROM notes n WHERE n.id=${input.noteId} AND n."ownerSubject"=${owner} AND n."removedAt" IS NULL LIMIT 1`)
            : [];
          const chunks = notes.length
            ? await tx.$queryRaw<ChunkDiagnostic[]>(Prisma.sql`
          SELECT c.id,c.section,c.ordinal,c."sourceRevision",c."chunkerVersion",
            c."sourceRevision"=n."sourceRevision" AS "revisionMatches",c."noteContentHash"=n."contentHash" AS "hashMatches",
            (${current}) AS current,e.provider,e."modelId" AS model,e.dimensions,e.status,
            e.vector IS NOT NULL AS "hasVector",coalesce((${eligible}),false) AS eligible,
            ${literal ? Prisma.sql`CASE WHEN ${eligible} THEN 1-(e.vector <=> ${literal}::vector) ELSE NULL END` : Prisma.sql`NULL::float8`} AS similarity
          FROM notes n JOIN note_chunks c ON c."noteId"=n.id AND c."ownerSubject"=n."ownerSubject"
          LEFT JOIN chunk_embeddings e ON e."chunkId"=c.id
          WHERE n.id=${input.noteId} AND n."ownerSubject"=${owner} AND n."removedAt" IS NULL AND c."ownerSubject"=${owner}
          ORDER BY c.section,c.ordinal,e.id LIMIT 21`)
            : [];
          const [noteCounts] = notes.length
            ? await tx.$queryRaw<
                Array<{
                  totalChunks: number;
                  currentChunks: number;
                  eligibleChunks: number;
                  staleChunks: number;
                  pending: number;
                  leased: number;
                  retrying: number;
                  failed: number;
                  incompatibleEmbeddings: number;
                  missingEmbeddings: number;
                }>
              >(Prisma.sql`
          SELECT count(DISTINCT c.id)::int AS "totalChunks",count(DISTINCT c.id) FILTER(WHERE ${current})::int AS "currentChunks",
            count(DISTINCT c.id) FILTER(WHERE ${eligible})::int AS "eligibleChunks",
            count(DISTINCT c.id) FILTER(WHERE NOT (${current}))::int AS "staleChunks",
            count(*) FILTER(WHERE ${current} AND ${compatible} AND e.status='PENDING')::int AS pending,
            count(*) FILTER(WHERE ${current} AND ${compatible} AND e.status='LEASED')::int AS leased,
            count(*) FILTER(WHERE ${current} AND ${compatible} AND e.status='RETRY')::int AS retrying,
            count(*) FILTER(WHERE ${current} AND ${compatible} AND e.status='FAILED')::int AS failed,
            count(*) FILTER(WHERE ${current} AND e.id IS NOT NULL AND NOT (${compatible}))::int AS "incompatibleEmbeddings",
            count(DISTINCT c.id) FILTER(WHERE ${current} AND NOT EXISTS (
              SELECT 1 FROM chunk_embeddings e WHERE e."chunkId"=c.id AND ${compatible}
            ))::int AS "missingEmbeddings"
          FROM notes n JOIN note_chunks c ON c."noteId"=n.id AND c."ownerSubject"=n."ownerSubject"
          LEFT JOIN chunk_embeddings e ON e."chunkId"=c.id
          WHERE n.id=${input.noteId} AND n."ownerSubject"=${owner} AND n."removedAt" IS NULL AND c."ownerSubject"=${owner}`)
            : [];
          return {
            health: health!,
            rankings,
            note: input.noteId
              ? notes[0]
                ? {
                    ...notes[0],
                    ...noteCounts!,
                    chunks: chunks.slice(0, 20),
                    chunksTruncated: chunks.length > 20,
                  }
                : null
              : undefined,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: 8000,
        },
      );
    },
  };
}
