import { Prisma, type PrismaClient } from "@prisma/client";
import { CHUNKER_VERSION } from "@pce/core";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embedding-jobs.js";
export interface SearchInput {
  query: string;
  tags?: string[] | undefined;
  project?: string | undefined;
  kind?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
}
export interface SearchRow {
  id: string;
  title: string;
  snippet: string;
  capturedAt: Date;
  sourceRevision: string;
  channel: "github" | "api" | "other";
  tags: string[];
  projects: string[];
  kind: string;
  lexical: boolean;
  semantic: boolean;
}
const validOwner = (owner: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(owner))
    throw new TypeError("Invalid verified owner");
};
export function createSearchRepository(db: PrismaClient) {
  return {
    async hasIndex(owner: string) {
      validOwner(owner);
      const [row] = await db.$queryRaw<
        Array<{ present: boolean }>
      >`SELECT EXISTS(SELECT 1 FROM "chunk_embeddings" e JOIN "note_chunks" c ON c."id"=e."chunkId" JOIN "notes" n ON n."id"=c."noteId" AND n."ownerSubject"=c."ownerSubject" WHERE c."ownerSubject"=${owner} AND c."sourceRevision"=n."sourceRevision" AND c."noteContentHash"=n."contentHash" AND c."chunkerVersion"=${CHUNKER_VERSION} AND e."status"='READY' AND e."vector" IS NOT NULL AND e."provider"='openai' AND e."modelId"=${EMBEDDING_MODEL} AND e."dimensions"=${EMBEDDING_DIMENSIONS}) AS present`;
      return row?.present === true;
    },
    async searchByOwner(owner: string, input: SearchInput, vector?: number[]) {
      validOwner(owner);
      if (!input.query.trim() || input.query.length > 500)
        throw new TypeError("Invalid search query");
      if (
        vector &&
        (vector.length !== 1536 ||
          vector.some((v) => !Number.isFinite(v)) ||
          !vector.some((v) => v !== 0))
      )
        throw new TypeError("Invalid query vector");
      const literal = vector ? "[" + vector.join(",") + "]" : null;
      const filter = Prisma.sql`n."ownerSubject"=${owner}
    ${input.tags?.length ? Prisma.sql`AND n.tags @> ${input.tags}::text[]` : Prisma.empty}
    ${input.project ? Prisma.sql`AND ${input.project}=ANY(n.projects)` : Prisma.empty}
    ${input.kind ? Prisma.sql`AND n.kind=${input.kind}` : Prisma.empty}
    ${input.start ? Prisma.sql`AND n."capturedAt">=${new Date(input.start)}` : Prisma.empty}
    ${input.end ? Prisma.sql`AND n."capturedAt"<${new Date(input.end)}` : Prisma.empty}`;
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout','2000',true)`;
        return tx.$queryRaw<SearchRow[]>(Prisma.sql`
     WITH filtered AS NOT MATERIALIZED (
       SELECT n.*,to_tsvector('simple'::regconfig,n.title||E'\n'||n.summary||E'\n'||n.body||E'\n'||n."originalInput") AS document
       FROM notes n WHERE ${filter}
     ), lexical AS (
       SELECT id,row_number() OVER(ORDER BY ts_rank(document,to_tsquery('simple'::regconfig,replace(plainto_tsquery('simple'::regconfig,${input.query})::text,' & ',' | '))) DESC,"capturedAt" DESC,id COLLATE "C") AS rank
       FROM filtered WHERE document @@ to_tsquery('simple'::regconfig,replace(plainto_tsquery('simple'::regconfig,${input.query})::text,' & ',' | '))
          OR strpos(lower(title||E'\n'||summary||E'\n'||body||E'\n'||"originalInput"),lower(${input.query}))>0
       ORDER BY rank LIMIT 200
     ), distances AS (
       ${
         literal
           ? Prisma.sql`SELECT f.id,min(e.vector <=> ${literal}::vector) AS distance
        FROM filtered f JOIN note_chunks c ON c."noteId"=f.id AND c."ownerSubject"=f."ownerSubject"
        JOIN chunk_embeddings e ON e."chunkId"=c.id
        WHERE c."ownerSubject"=${owner} AND c."sourceRevision"=f."sourceRevision"
         AND c."noteContentHash"=f."contentHash" AND c."chunkerVersion"=${CHUNKER_VERSION}
         AND e.status='READY' AND e.vector IS NOT NULL AND e.provider='openai'
         AND e."modelId"=${EMBEDDING_MODEL} AND e.dimensions=${EMBEDDING_DIMENSIONS}
        GROUP BY f.id HAVING min(e.vector <=> ${literal}::vector)<0.85
        ORDER BY distance,f.id COLLATE "C" LIMIT 200`
           : Prisma.sql`SELECT id,0.0::double precision AS distance FROM filtered WHERE false`
       }
     ), semantic AS (SELECT id,row_number() OVER(ORDER BY distance,id COLLATE "C") AS rank FROM distances),
     ranked AS (SELECT coalesce(l.id,s.id) AS id,coalesce(1.0/(60+l.rank),0)+coalesce(1.0/(60+s.rank),0) AS score,
          l.id IS NOT NULL AS lexical,s.id IS NOT NULL AS semantic
       FROM lexical l FULL JOIN semantic s ON l.id=s.id)
     SELECT f.id,f.title,left(f."originalInput",240) AS snippet,f."capturedAt",f."sourceRevision",
       CASE WHEN f."sourcePath" LIKE 'api/%' THEN 'api' WHEN f."sourcePath" LIKE 'inbox/%' OR f."sourcePath" LIKE 'notes/%' THEN 'github' ELSE 'other' END AS channel,
       f.tags,f.projects,f.kind,r.lexical,r.semantic
     FROM ranked r JOIN filtered f ON f.id=r.id
     ORDER BY r.score DESC,f."capturedAt" DESC,f.id COLLATE "C" ASC LIMIT 201
    `);
      });
    },
    async getByOwner(owner: string, id: string) {
      validOwner(owner);
      const n = await db.note.findFirst({ where: { id, ownerSubject: owner } });
      if (!n) return null;
      return {
        id: n.id,
        title: n.title,
        summary: n.summary,
        tags: n.tags,
        capturedAt: n.capturedAt.toISOString(),
        body: n.body,
        originalInput: n.originalInput,
        metadata: {
          capturedAtRaw: n.capturedAtRaw,
          source: n.source,
          kind: n.kind,
          domains: n.domains,
          projects: n.projects,
          actionHint: n.actionHint,
          reviewRequired: n.reviewRequired,
          occurredAt: n.occurredAtRaw,
          dueAt: n.dueAtRaw,
          timezone: n.timezone,
        },
      };
    },
    // Query requests share conservative day counters with indexing; rate-limited
    // separately to avoid an interactive query starving the indexing scan cursor.
    async reserveQuery(owner: string, text: string, now = new Date()) {
      validOwner(owner);
      const day = now.toISOString().slice(0, 10);
      const reservation = Math.min(8192, Buffer.byteLength(text, "utf8") + 16);
      const rows = await db.$queryRaw<
        Array<{ reservedTokens: number }>
      >`INSERT INTO embedding_daily_budgets ("ownerSubject",day,"reservedTokens","requestCount")
    VALUES (${owner},${day}::date,${reservation},1)
    ON CONFLICT ("ownerSubject",day) DO UPDATE SET "reservedTokens"=embedding_daily_budgets."reservedTokens"+${reservation},"requestCount"=embedding_daily_budgets."requestCount"+1
    WHERE embedding_daily_budgets."reservedTokens"+${reservation}<=60000 RETURNING "reservedTokens"`;
      return rows.length === 1;
    },
  };
}
export type SearchRepository = ReturnType<typeof createSearchRepository>;
