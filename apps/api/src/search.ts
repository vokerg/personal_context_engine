import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  SearchRequestSchema,
  SearchResponseSchema,
  type SearchResponse,
  type SearchRequest,
} from "@pce/contracts";
import type { SearchRepository } from "@pce/db";
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
) {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("Search cursor secret required");
  const cache = new Map<string, { at: number; vector: number[] }>();
  const windows = new Map<string, { at: number; count: number }>();
  const sign = (value: string) =>
    createHmac("sha256", secret).update(value).digest("base64url");
  const safe = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return {
    getByOwner: repo.getByOwner,
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
          "text-embedding-3-small",
          1536,
          "unicode-nfc-lf-2048-v1",
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
      let vector: number[] | undefined;
      let degradation: SearchResponse["degradation"] = provider
        ? "unindexed"
        : "disabled";
      if (provider && (await repo.hasIndex(owner))) {
        const old = cache.get(key);
        if (old && now() - old.at < 300_000) {
          vector = old.vector;
          degradation = null;
        } else {
          let window = windows.get(owner);
          if (!window || now() - window.at >= 60_000) {
            window = { at: now(), count: 0 };
            windows.set(owner, window);
          }
          if (
            window.count >= 4 ||
            !(await repo.reserveQuery(owner, input.query))
          )
            degradation = "budget_exhausted";
          else
            try {
              window.count++;
              const result = await provider.embed(input.query);
              if (
                result.vector.length !== 1536 ||
                result.vector.some((v) => !Number.isFinite(v)) ||
                !result.vector.some((v) => v !== 0) ||
                !Number.isSafeInteger(result.usageTokens) ||
                result.usageTokens < 0 ||
                result.usageTokens >
                  Math.min(8192, Buffer.byteLength(input.query, "utf8") + 16)
              )
                throw new Error("Invalid embedding");
              vector = result.vector;
              degradation = null;
              if (cache.size >= 128) cache.delete(cache.keys().next().value!);
              cache.set(key, { at: now(), vector });
            } catch {
              degradation = "provider_unavailable";
            }
        }
      }
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
