import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  SearchRequestSchema,
  DiagnoseSearchRequestSchema,
  type DiagnoseSearchRequest,
  SearchResponseSchema,
  type SearchResponse,
  type SearchRequest,
} from "@pce/contracts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  SEARCH_COSINE_THRESHOLD,
  SEARCH_RRF_K,
  SEARCH_RANKING_VERSION,
  type SearchRepository,
} from "@pce/db";
import { CHUNKER_VERSION } from "@pce/core";
export interface QueryEmbeddingProvider {
  embed(text: string): Promise<{ vector: number[]; usageTokens: number }>;
}
export class SearchCursorError extends Error {
  constructor() {
    super("Invalid search cursor");
    this.name = "SearchCursorError";
  }
}
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export function createSearchService(
  repo: SearchRepository,
  secret: string,
  provider?: QueryEmbeddingProvider,
  now = () => Date.now(),
  diagnosticsEnabled = false,
) {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("Search cursor secret required");
  const cache = new Map<string, { at: number; vector: number[] }>();
  const windows = new Map<string, { at: number; count: number }>();
  const sign = (value: string) =>
    createHmac("sha256", secret).update(value).digest("base64url");
  const safe = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  async function embedQuery(owner: string, query: string, key: string) {
    let vector: number[] | undefined;
    let embeddingSource: "not_executed" | "cache" | "provider" = "not_executed";
    let degradationReason:
      | "disabled"
      | "unindexed"
      | "rate_limit"
      | "daily_token_budget"
      | "provider_unavailable"
      | null = provider ? "unindexed" : "disabled";
    let degradation: SearchResponse["degradation"] = provider
      ? "unindexed"
      : "disabled";
    if (provider && (await repo.hasIndex(owner))) {
      const old = cache.get(key);
      if (old && now() - old.at < 300_000) {
        vector = old.vector;
        degradation = null;
        degradationReason = null;
        embeddingSource = "cache";
      } else {
        let window = windows.get(owner);
        if (!window || now() - window.at >= 60_000) {
          window = { at: now(), count: 0 };
          windows.set(owner, window);
        }
        if (window.count >= 4) {
          degradation = "budget_exhausted";
          degradationReason = "rate_limit";
        } else if (!(await repo.reserveQuery(owner, query))) {
          degradation = "budget_exhausted";
          degradationReason = "daily_token_budget";
        } else
          try {
            window.count++;
            const result = await provider.embed(query);
            if (
              result.vector.length !== 1536 ||
              result.vector.some((v) => !Number.isFinite(v)) ||
              !result.vector.some((v) => v !== 0) ||
              !Number.isSafeInteger(result.usageTokens) ||
              result.usageTokens < 0 ||
              result.usageTokens >
                Math.min(8192, Buffer.byteLength(query, "utf8") + 16)
            )
              throw new Error("Invalid embedding");
            vector = result.vector;
            degradation = null;
            degradationReason = null;
            embeddingSource = "provider";
            if (cache.size >= 128) cache.delete(cache.keys().next().value!);
            cache.set(key, { at: now(), vector });
          } catch {
            degradation = "provider_unavailable";
            degradationReason = "provider_unavailable";
          }
      }
    }
    return { vector, degradation, degradationReason, embeddingSource };
  }
  return {
    getByOwner: repo.getByOwner,
    researchEnabled: repo.researchEnabled,
    getResearchByOwner: repo.getResearchByOwner,
    diagnosticsEnabled,
    async diagnoseByOwner(owner: string, raw: DiagnoseSearchRequest) {
      if (!diagnosticsEnabled) throw new Error("Search diagnostics disabled");
      const input = DiagnoseSearchRequestSchema.parse(raw);
      // Shares query cache, per-owner rate window and durable token budget with search.
      const key = digest(
        JSON.stringify([
          owner,
          { query: input.query, limit: 20 },
          EMBEDDING_MODEL,
          EMBEDDING_DIMENSIONS,
          CHUNKER_VERSION,
          SEARCH_RANKING_VERSION,
        ]),
      );
      const embedding = await embedQuery(owner, input.query, key);
      let { vector, degradation } = embedding;
      const { degradationReason, embeddingSource } = embedding;
      let data;
      let semanticQueryFailed = false;
      try {
        data = await repo.inspectByOwner(owner, input, vector);
      } catch (error) {
        if (!vector) throw error;
        vector = undefined;
        degradation = "provider_unavailable";
        semanticQueryFailed = true;
        data = await repo.inspectByOwner(owner, input);
      }
      const candidate = data.rankings.find((r) => r.id === input.noteId);
      const note = data.note;
      const semanticReason = !note
        ? "not_found"
        : !note.matchesIdentifiers
          ? "identifier_mismatch"
          : !note.totalChunks
            ? "no_chunks"
            : !note.currentChunks
              ? "stale_chunks"
              : !note.eligibleChunks
                ? "no_current_ready_embedding"
                : !vector
                  ? "semantic_not_executed"
                  : candidate?.passedThreshold === false
                    ? "below_similarity_threshold"
                    : candidate?.passedKeywordGate === false
                      ? "below_keyword_anchor"
                      : !candidate?.semanticRank
                        ? "outside_semantic_candidate_window"
                        : "semantic_candidate";
      const reason = !note
        ? "not_found"
        : candidate?.finalRank
          ? candidate.finalRank > 200
            ? "outside_result_window"
            : candidate.finalRank > input.limit
              ? "outside_requested_limit"
              : "included"
          : semanticReason;
      return {
        index: data.health,
        execution: {
          mode: vector ? "hybrid" : "lexical",
          degradation,
          providerConfigured: !!provider,
          degradationReason: semanticQueryFailed
            ? "semantic_query_unavailable"
            : degradationReason,
          embeddingSource,
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMENSIONS,
          chunkerVersion: CHUNKER_VERSION,
          cosineThreshold: SEARCH_COSINE_THRESHOLD,
          thresholdComparison: "strictly_greater",
          rrfK: SEARCH_RRF_K,
          candidateLimit: 200,
          resultLimit: input.limit,
          rankingVersion: SEARCH_RANKING_VERSION,
          rankingScope: "notes",
          lexicalConfiguration: "simple+english+russian",
          lexicalOperator: "OR",
          lexicalVotePolicy: vector ? "complete_query_only" : "all_candidates",
          identifierPolicy: "literal_alphanumeric_tokens",
          lexicalWeights: { title: "A", summary: "B", body: "D" },
          semanticPruning: "single_token_title_anchor",
          keywordAnchorSimilarity:
            data.rankings[0]?.keywordAnchorSimilarity ?? null,
          semanticMeaning:
            "eligible chunk passed cosine threshold; not a relevance confidence",
        },
        candidates: data.rankings.map((r) => ({
          ...r,
          included:
            r.finalRank !== null && r.finalRank <= Math.min(input.limit, 200),
        })),
        ...(input.noteId
          ? {
              note: note
                ? {
                    ...note,
                    ranking: candidate ?? null,
                    reason,
                    semanticReason,
                  }
                : { status: "not_found" },
            }
          : {}),
      };
    },
    async searchByOwner(
      owner: string,
      raw: SearchRequest,
    ): Promise<SearchResponse> {
      const input = SearchRequestSchema.parse(raw),
        { cursor, ...parameters } = input;
      const key = digest(
        JSON.stringify([
          owner,
          parameters,
          EMBEDDING_MODEL,
          EMBEDDING_DIMENSIONS,
          CHUNKER_VERSION,
          SEARCH_RANKING_VERSION,
        ]),
      );
      let offset = 0,
        priorSnapshot: string | undefined;
      if (cursor)
        try {
          const parts = JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
          );
          if (
            !Array.isArray(parts) ||
            parts.length !== 2 ||
            typeof parts[0] !== "string" ||
            typeof parts[1] !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(parts[1]) ||
            !safe(sign(parts[0]), parts[1])
          )
            throw new Error("cursor");
          const c = JSON.parse(parts[0]);
          if (
            c.key !== key ||
            !Number.isInteger(c.offset) ||
            c.offset < 0 ||
            c.offset > 200 ||
            typeof c.snapshot !== "string" ||
            !Number.isSafeInteger(c.at) ||
            c.at > now() ||
            now() - c.at > 300_000
          )
            throw new Error("cursor");
          offset = c.offset;
          priorSnapshot = c.snapshot;
        } catch {
          throw new SearchCursorError();
        }
      let { vector, degradation } = await embedQuery(owner, input.query, key);
      let rows;
      try {
        rows = await repo.searchByOwner(owner, input, vector);
      } catch (error) {
        if (!vector) throw error;
        vector = undefined;
        degradation = "provider_unavailable";
        rows = await repo.searchByOwner(owner, input);
      }
      const bounded = rows.slice(0, 200),
        snapshot = digest(
          JSON.stringify(bounded.map((r) => [r.id, r.sourceRevision])),
        );
      if (priorSnapshot && priorSnapshot !== snapshot)
        throw new SearchCursorError();
      const results = bounded
        .slice(offset, offset + input.limit)
        .map((r) => ({ ...r, capturedAt: r.capturedAt.toISOString() }));
      const payload = JSON.stringify({
        key,
        offset: offset + input.limit,
        snapshot,
        at: now(),
      });
      return SearchResponseSchema.parse({
        mode: vector ? "hybrid" : "lexical",
        degradation,
        results,
        nextCursor:
          offset + input.limit < bounded.length
            ? Buffer.from(JSON.stringify([payload, sign(payload)])).toString(
                "base64url",
              )
            : null,
        truncated: rows.length > 200,
      });
    },
  };
}
export type SearchService = ReturnType<typeof createSearchService>;
