import { createResearchSearchRepository } from "./research-search.js";
import { createResearchRepository } from "./research.js";
import { createSearchDiagnosticsRepository } from "./search-diagnostics.js";
import { effective } from "./note-tags.js";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  searchRanking,
  validOwner,
  validQueryVector,
  eligibleEmbedding,
} from "./search-ranking.js";
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
  contentType?: "note" | "research";
  parentNoteId?: string;
  score?: number;
  lexical: boolean;
  semantic: boolean;
}
export function createSearchRepository(
  db: PrismaClient,
  researchEnabled = false,
) {
  const research = researchEnabled ? createResearchSearchRepository(db) : null;
  return {
    researchEnabled,
    ...createSearchDiagnosticsRepository(db),
    async hasIndex(owner: string) {
      validOwner(owner);
      const [row] = await db.$queryRaw<Array<{ present: boolean }>>(
        Prisma.sql`SELECT EXISTS(SELECT 1 FROM "chunk_embeddings" e JOIN "note_chunks" c ON c."id"=e."chunkId" JOIN "notes" n ON n."id"=c."noteId" AND n."ownerSubject"=c."ownerSubject" WHERE c."ownerSubject"=${owner} AND ${eligibleEmbedding()}) AS present`,
      );
      return (
        row?.present === true ||
        Boolean(research && (await research.hasIndex(owner)))
      );
    },
    async searchByOwner(owner: string, input: SearchInput, vector?: number[]) {
      validOwner(owner);
      if (!input.query.trim() || input.query.length > 500)
        throw new TypeError("Invalid search query");
      if (vector && !validQueryVector(vector))
        throw new TypeError("Invalid query vector");
      const literal = vector ? "[" + vector.join(",") + "]" : null;
      const notes = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout','2000',true)`;
        return tx.$queryRaw<SearchRow[]>(Prisma.sql`
     ${searchRanking(owner, input, literal)}
     SELECT f.id,f.title,left(f."originalInput",240) AS snippet,f."capturedAt",f."sourceRevision",
       CASE WHEN f."sourcePath" LIKE 'api/%' THEN 'api' WHEN f."sourcePath" LIKE 'inbox/%' OR f."sourcePath" LIKE 'notes/%' THEN 'github' ELSE 'other' END AS channel,
       f."effectiveTags" AS tags,f.projects,f.kind,r.lexical,r.semantic,r.score::double precision AS score
     FROM ranked r JOIN filtered f ON f.id=r.id
     ORDER BY r.score DESC,f."capturedAt" DESC,f.id COLLATE "C" ASC LIMIT 201
    `);
      });
      const reports = research
        ? await research.searchByOwner(owner, input, vector)
        : [];
      return [...notes, ...reports]
        .sort(
          (a, b) =>
            (b.score ?? 0) - (a.score ?? 0) ||
            b.capturedAt.getTime() - a.capturedAt.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, 201)
        .map((row) => {
          const result = { ...row };
          delete result.score;
          return result;
        });
    },
    async getByOwner(owner: string, id: string) {
      validOwner(owner);
      const n = await db.note.findFirst({
        where: { id, ownerSubject: owner },
        include: { tagOverride: true },
      });
      if (!n) return null;
      return {
        id: n.id,
        title: n.title,
        summary: n.summary,
        tags: effective(
          n.tags,
          n.tagOverride?.added ?? [],
          n.tagOverride?.removed ?? [],
        ),
        tagEditing: {
          sourceTags: n.tags,
          manualAdded: n.tagOverride?.added ?? [],
          manualRemoved: n.tagOverride?.removed ?? [],
          revision: n.tagOverride?.revision ?? 0,
        },
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
    async getResearchByOwner(owner: string, id: string) {
      return research
        ? createResearchRepository(db).getByOwner(owner, id)
        : null;
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
