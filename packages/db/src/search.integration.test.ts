import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PrismaClient,
  createApiCaptureRepository,
  createEmbeddingJobRepository,
  createSearchRepository,
} from "./index.js";
import { createSearchService } from "../../../apps/api/src/search.js";
import { createSessionAuth } from "../../../apps/api/src/session-auth.js";
import { createApp } from "../../../apps/api/src/app.js";
const url = process.env.PCE_DB_TEST_URL;
const basis = (n: number) =>
  Array.from({ length: 1536 }, (_, i) => (i === n ? 1 : 0));
describe.skipIf(!url)(
  "owner-scoped hybrid search with synthetic pgvector corpus",
  () => {
    let db: PrismaClient;
    const owners: string[] = [],
      notes: string[] = [],
      captures: string[] = [];
    async function seed(
      owner: string,
      original: string,
      vector?: number[],
      title = "Synthetic source",
    ) {
      owners.push(owner);
      const id = randomUUID(),
        capture = randomUUID();
      notes.push(id);
      captures.push(capture);
      const markdown = `---
schema_version: 1
id: ${id}
capture_id: ${capture}
captured_at: 2026-10-20T09:00:00+02:00
source: chatgpt_text
kind: memo
domains: []
projects: [synthetic]
tags: [finance]
action_hint: none
review_required: false
title: ${JSON.stringify(title)}
---

# ${title}

## Summary

Synthetic summary.

## Original input

${original}
`;
      await createApiCaptureRepository(db).persistByOwner(owner, {
        idempotencyKey: randomUUID(),
        notes: [markdown],
      });
      if (vector) {
        await createEmbeddingJobRepository(db).prepareNote(id, owner);
        const literal = "[" + vector.join(",") + "]";
        await db.$executeRaw`UPDATE chunk_embeddings e SET vector=${literal}::vector,status='READY' FROM note_chunks c WHERE c.id=e."chunkId" AND c."noteId"=${id} AND c."ownerSubject"=${owner}`;
      }
      return id;
    }
    beforeAll(async () => {
      db = new PrismaClient({ datasources: { db: { url: url! } } });
      await db.$connect();
    });
    afterAll(async () => {
      if (db) {
        await db.authSession.deleteMany({
          where: { ownerSubject: { in: owners } },
        });
        await db.apiCaptureReceipt.deleteMany({
          where: { ownerSubject: { in: owners } },
        });
        await db.note.deleteMany({ where: { id: { in: notes } } });
        await db.capture.deleteMany({ where: { id: { in: captures } } });
        await db.embeddingDailyBudget.deleteMany({
          where: { ownerSubject: { in: owners } },
        });
        await db.$disconnect();
      }
    });

    const similarity = (cosine: number) =>
      Array.from({ length: 1536 }, (_, i) =>
        i === 0 ? cosine : i === 1 ? Math.sqrt(1 - cosine ** 2) : 0,
      );

    it("stems Russian and English, prioritizes titles and retains partial lexical fallback", async () => {
      const owner = "multilingual-" + randomUUID();
      const russian = await seed(owner, "Починить театральные костюмы.");
      const english = await seed(owner, "Renew observatory permits.");
      const title = await seed(
        owner,
        "Check the harvest plan.",
        undefined,
        "Orchard apples",
      );
      await seed(
        owner,
        "orchard orchard orchard orchard",
        undefined,
        "Other task",
      );
      const repo = createSearchRepository(db);
      expect(
        (
          await repo.searchByOwner(owner, { query: "театральными костюмами" })
        ).map((r) => r.id),
      ).toContain(russian);
      expect(
        (
          await repo.searchByOwner(owner, { query: "observatories permit" })
        ).map((r) => r.id),
      ).toContain(english);
      expect(
        (await repo.searchByOwner(owner, { query: "orchard" }))[0]?.id,
      ).toBe(title);
      expect(
        (await repo.searchByOwner(owner, { query: "unmentioned harvest" })).map(
          (r) => r.id,
        ),
      ).toContain(title);
    });

    it("does not award incidental lexical overlap an extra hybrid fusion vote", async () => {
      const owner = "fusion-" + randomUUID();
      const relevant = await seed(
        owner,
        "Renew the access permit for the telescope dome.",
        similarity(0.55),
      );
      const incidental = await seed(
        owner,
        "The facility has the the the the museum brochures.",
        similarity(0.2),
      );
      const query =
        "How do I keep permission to enter the stargazing facility?";
      const repo = createSearchRepository(db);
      const rows = await repo.searchByOwner(owner, { query }, basis(0));
      expect(rows[0]?.id).toBe(relevant);
      const diagnostic = await repo.inspectByOwner(
        owner,
        { query, limit: 20 },
        basis(0),
      );
      const weak = diagnostic.rankings.find((r) => r.id === incidental)!;
      expect(weak.lexicalRank).not.toBeNull();
      expect(weak.lexicalVote).toBe(false);
      expect(weak.rrfScore).toBeCloseTo(1 / (60 + weak.semanticRank!), 10);
      expect(
        diagnostic.rankings
          .filter((r) => r.finalRank !== null)
          .map((r) => r.id),
      ).toEqual(rows.map((r) => r.id));
    });

    it("requires complete identifier tokens in both branches and explains exclusions without text", async () => {
      const owner = "identifier-" + randomUUID();
      const exact = await seed(
        owner,
        "Replace encoder AX-912.",
        similarity(0.3),
      );
      const prefix = await seed(owner, "Replace encoder AX-9120.", basis(0));
      await seed(owner, "Replace encoder AX-913.", basis(0));
      const repo = createSearchRepository(db);
      for (const vector of [undefined, basis(0)])
        expect(
          (await repo.searchByOwner(owner, { query: "AX-912" }, vector)).map(
            (r) => r.id,
          ),
        ).toEqual([exact]);
      expect(
        await repo.searchByOwner(owner, { query: "AX-999" }, basis(0)),
      ).toEqual([]);
      const service = createSearchService(
        repo,
        "s".repeat(32),
        { embed: async () => ({ vector: basis(0), usageTokens: 1 }) },
        undefined,
        true,
      );
      const diagnostic = await service.diagnoseByOwner(owner, {
        query: "AX-912",
        noteId: prefix,
        limit: 20,
      });
      expect(diagnostic.note).toMatchObject({
        reason: "identifier_mismatch",
        semanticReason: "identifier_mismatch",
        matchesIdentifiers: false,
      });
      expect(JSON.stringify(diagnostic)).not.toContain("Replace encoder");
    });

    it("retains weak semantic and unindexed partial matches behind stronger candidates", async () => {
      const owner = "recall-" + randomUUID();
      await seed(owner, "A stronger semantic source", similarity(0.9));
      const weak = await seed(
        owner,
        "A useful distant paraphrase",
        similarity(0.274),
      );
      const partial = await seed(owner, "permission to enter a facility");
      const query =
        "How do I keep permission to enter the stargazing facility?";
      const rows = await createSearchRepository(db).searchByOwner(
        owner,
        { query },
        basis(0),
      );
      expect(rows.map((r) => r.id)).toContain(weak);
      expect(rows.map((r) => r.id)).toContain(partial);
      expect(rows.findIndex((r) => r.id === weak)).toBeLessThan(
        rows.findIndex((r) => r.id === partial),
      );
    });

    it("diagnoses coverage, exact cosine, below-threshold candidates and RRF without exposing foreign data or vectors", async () => {
      const owner = "diagnostics-" + randomUUID();
      const relevant = await seed(owner, "synthetic needle", basis(0));
      const weak = await seed(
        owner,
        "unrelated",
        Array.from({ length: 1536 }, (_, i) =>
          i === 0 ? 0.1 : i === 1 ? Math.sqrt(0.99) : 0,
        ),
      );
      const missing = await seed(owner, "needle without vector");
      const foreign = await seed("foreign-" + randomUUID(), "needle", basis(0));
      const repo = createSearchRepository(db);
      const provider = {
        embed: vi.fn(async () => ({ vector: basis(0), usageTokens: 2 })),
      };
      const service = createSearchService(
        repo,
        "s".repeat(32),
        provider,
        undefined,
        true,
      );
      const diagnostic = await service.diagnoseByOwner(owner, {
        query: "needle",
        noteId: missing,
        limit: 20,
      });
      expect(diagnostic.execution).toMatchObject({
        rankingVersion: "multilingual-complete-v2",
        rankingScope: "notes",
        lexicalConfiguration: "simple+english+russian",
        lexicalOperator: "OR",
        lexicalVotePolicy: "complete_query_only",
        identifierPolicy: "literal_alphanumeric_tokens",
        cosineThreshold: 0.15,
        rrfK: 60,
      });
      expect(diagnostic.index).toMatchObject({
        totalNotes: 3,
        indexedNotes: 2,
        fullyIndexedNotes: 2,
        coveragePercent: 66.67,
        missingNotes: 1,
      });
      expect(diagnostic.note).toMatchObject({
        id: missing,
        totalChunks: 0,
        eligibleChunks: 0,
        reason: "included",
      });
      const strong = diagnostic.candidates.find((c) => c.id === relevant)!;
      expect(strong).toMatchObject({
        semanticRank: 1,
        passedThreshold: true,
        finalRank: 1,
      });
      expect(strong.bestSimilarity).toBeCloseTo(1, 6);
      expect(strong.rrfScore).toBeCloseTo(
        1 / (60 + strong.lexicalRank!) + 1 / 61,
        10,
      );
      expect(diagnostic.candidates.find((c) => c.id === weak)).toMatchObject({
        passedThreshold: false,
        semanticRank: null,
        finalRank: null,
      });
      expect(
        diagnostic.candidates.find((c) => c.id === weak)!.bestSimilarity,
      ).toBeCloseTo(0.1, 6);
      const production = await service.searchByOwner(owner, {
        query: "needle",
        limit: 20,
      });
      expect(
        diagnostic.candidates.filter((c) => c.included).map((c) => c.id),
      ).toEqual(production.results.map((c) => c.id));
      expect(provider.embed).toHaveBeenCalledTimes(1);
      const text = JSON.stringify(diagnostic);
      expect(text).not.toContain(foreign);
      expect(text).not.toContain('"vector":');
      expect(text).not.toContain("needle without vector");
      const privateNote = await service.diagnoseByOwner(owner, {
        query: "needle",
        noteId: foreign,
        limit: 5,
      });
      const absent = await service.diagnoseByOwner(owner, {
        query: "needle",
        noteId: randomUUID(),
        limit: 5,
      });
      expect(privateNote.note).toEqual(absent.note);
      expect(privateNote.candidates.some((c) => c.id === foreign)).toBe(false);
      const excluded = await service.diagnoseByOwner(owner, {
        query: "absent",
        noteId: missing,
        limit: 5,
      });
      expect(excluded.note).toMatchObject({
        reason: "no_chunks",
        eligibleChunks: 0,
      });
      await expect(
        createSearchService(repo, "s".repeat(32), provider).diagnoseByOwner(
          owner,
          { query: "needle", limit: 5 },
        ),
      ).rejects.toThrow("disabled");
      await expect(
        service.diagnoseByOwner(owner, { query: "needle", limit: 21 }),
      ).rejects.toThrow();
    });
    it("counts stale, missing, incompatible and queued embeddings and explains lexical degradation", async () => {
      const owner = "health-" + randomUUID(),
        repo = createSearchRepository(db);
      const ready = await seed(owner, "health", basis(0));
      const stale = await seed(owner, "health stale", basis(0));
      await db.noteChunk.updateMany({
        where: { noteId: stale, ownerSubject: owner },
        data: { sourceRevision: "stale" },
      });
      const wrong = await seed(owner, "health obsolete", basis(0));
      await db.chunkEmbedding.updateMany({
        where: { chunk: { noteId: wrong, ownerSubject: owner } },
        data: { modelId: "old-model" },
      });
      const statusCounts: Record<string, number> = {};
      for (const status of ["PENDING", "LEASED", "RETRY", "FAILED"] as const) {
        const id = await seed(owner, "health " + status);
        await createEmbeddingJobRepository(db).prepareNote(id, owner);
        const changed = await db.chunkEmbedding.updateMany({
          where: { chunk: { noteId: id, ownerSubject: owner } },
          data: { status },
        });
        statusCounts[status] = changed.count;
      }
      const noEmbedding = await seed(
        owner,
        "health missing embedding",
        basis(0),
      );
      const deleted = await db.chunkEmbedding.deleteMany({
        where: { chunk: { noteId: noEmbedding, ownerSubject: owner } },
      });
      const inspect = await repo.inspectByOwner(
        owner,
        { query: "health", noteId: stale, limit: 5 },
        basis(0),
      );
      expect(inspect.health).toMatchObject({
        totalNotes: 8,
        indexedNotes: 1,
        coveragePercent: 12.5,
        missingEmbeddings: deleted.count + 3,
        incompatibleEmbeddings: 3,
        pending: statusCounts.PENDING,
        leased: statusCounts.LEASED,
        retrying: statusCounts.RETRY,
        failed: statusCounts.FAILED,
        staleChunks: 3,
      });
      expect(inspect.note).toMatchObject({
        eligibleChunks: 0,
        currentChunks: 0,
        staleChunks: 3,
      });
      const down = createSearchService(
        repo,
        "s".repeat(32),
        {
          embed: async () => {
            throw Error("private payload");
          },
        },
        undefined,
        true,
      );
      const fallback = await down.diagnoseByOwner(owner, {
        query: "health",
        noteId: ready,
        limit: 5,
      });
      expect(fallback.execution).toMatchObject({
        mode: "lexical",
        degradation: "provider_unavailable",
      });
      expect(
        fallback.candidates.every(
          (c) => c.bestSimilarity === null && c.semanticRank === null,
        ),
      ).toBe(true);
      expect(JSON.stringify(fallback)).not.toContain("private payload");
      const disabled = await createSearchService(
        repo,
        "s".repeat(32),
        undefined,
        undefined,
        true,
      ).diagnoseByOwner(owner, { query: "health", limit: 5 });
      expect(disabled.execution.degradation).toBe("disabled");
      await db.embeddingDailyBudget.updateMany({
        where: { ownerSubject: owner },
        data: { reservedTokens: 60000 },
      });
      const embed = vi.fn();
      const budget = await createSearchService(
        repo,
        "s".repeat(32),
        { embed },
        undefined,
        true,
      ).diagnoseByOwner(owner, { query: "health", limit: 5 });
      expect(budget.execution.degradation).toBe("budget_exhausted");
      expect(budget.execution.degradationReason).toBe("daily_token_budget");
      expect(embed).not.toHaveBeenCalled();
      const empty = await createSearchService(
        repo,
        "s".repeat(32),
        { embed },
        undefined,
        true,
      ).diagnoseByOwner("empty-" + randomUUID(), { query: "health", limit: 5 });
      expect(empty.index.coveragePercent).toBe(0);
      expect(empty.execution.degradation).toBe("unindexed");
    });

    it("shares diagnostic/search rate limits and explains partial indexing and stale hashes/versions", async () => {
      const owner = "limits-" + randomUUID(),
        id = await seed(owner, "partial", basis(0)),
        repo = createSearchRepository(db);
      const chunk = await db.noteChunk.findFirstOrThrow({
        where: { noteId: id, ownerSubject: owner },
      });
      await db.$executeRaw`UPDATE chunk_embeddings SET vector=NULL,status='PENDING' WHERE "chunkId"=${chunk.id}`;
      let time = Date.now();
      const provider = {
        embed: vi.fn(async () => ({ vector: basis(0), usageTokens: 1 })),
      };
      const service = createSearchService(
        repo,
        "s".repeat(32),
        provider,
        () => time,
        true,
      );
      const first = await service.diagnoseByOwner(owner, {
        query: "first",
        noteId: id,
        limit: 5,
      });
      expect(first.index).toMatchObject({
        indexedNotes: 1,
        fullyIndexedNotes: 0,
        pending: 1,
      });
      expect(first.note).toMatchObject({ pending: 1, eligibleChunks: 2 });
      expect(
        first.note &&
          "chunks" in first.note &&
          first.note.chunks.find((c) => c.id === chunk.id),
      ).toMatchObject({ hasVector: false, eligible: false, similarity: null });
      await service.searchByOwner(owner, { query: "second", limit: 20 });
      await service.diagnoseByOwner(owner, { query: "third", limit: 5 });
      await service.searchByOwner(owner, { query: "fourth", limit: 20 });
      expect(
        (await service.diagnoseByOwner(owner, { query: "fifth", limit: 5 }))
          .execution.degradation,
      ).toBe("budget_exhausted");
      expect(
        (await service.diagnoseByOwner(owner, { query: "sixth", limit: 5 }))
          .execution.degradationReason,
      ).toBe("rate_limit");
      expect(provider.embed).toHaveBeenCalledTimes(4);
      time += 60001;
      expect(
        (await service.diagnoseByOwner(owner, { query: "fifth", limit: 5 }))
          .execution.mode,
      ).toBe("hybrid");
      expect(provider.embed).toHaveBeenCalledTimes(5);
      await db.noteChunk.updateMany({
        where: { noteId: id, ownerSubject: owner },
        data: { noteContentHash: "0".repeat(64), chunkerVersion: "old" },
      });
      const stale = await service.diagnoseByOwner(owner, {
        query: "partial",
        noteId: id,
        limit: 5,
      });
      expect(stale.note).toMatchObject({
        eligibleChunks: 0,
        semanticReason: "stale_chunks",
      });
      expect(stale.index.indexedNotes).toBe(0);
      expect(stale.execution.degradation).toBe("unindexed");
      await expect(
        repo.inspectByOwner(owner, { query: "partial", limit: 5 }, [1]),
      ).rejects.toThrow("Invalid query vector");
    });
    it("finds a no-shared-word Russian finance source through vectors, fuses lexical matches and excludes foreign owners", async () => {
      const owner = "search-" + randomUUID(),
        // Live synthetic OpenAI probe produced ~0.274 cosine for this paraphrase.
        // Keep a weak but relevant vector match; an exact basis match hid cutoff bugs.
        id = await seed(
          owner,
          "закрыть инвойс",
          Array.from({ length: 1536 }, (_, i) =>
            i === 0 ? 0.274 : i === 1 ? Math.sqrt(1 - 0.274 ** 2) : 0,
          ),
        );
      const foreign = await seed(
        "foreign-" + randomUUID(),
        "Какие были оплаты?",
        basis(0),
      );
      const query = "Какие были оплаты?";
      const repo = createSearchRepository(db);
      expect(await repo.searchByOwner(owner, { query })).toEqual([]);
      expect(
        (await repo.searchByOwner(owner, { query }, basis(0))).some(
          (n) => n.id === id,
        ),
      ).toBe(true);
      const lexical = await seed(owner, "оплаты подтверждены");
      const provider = {
        embed: vi.fn(async () => ({ vector: basis(0), usageTokens: 6 })),
      };
      const service = createSearchService(repo, "s".repeat(32), provider);
      const result = await service.searchByOwner(owner, { query, limit: 1 });
      expect(result.mode).toBe("hybrid");
      expect(result.results).toHaveLength(1);
      expect([id, lexical]).toContain(result.results[0]!.id);
      expect(result.nextCursor).not.toBeNull();
      const next = await service.searchByOwner(owner, {
        query,
        limit: 1,
        cursor: result.nextCursor!,
      });
      expect(
        new Set([...result.results, ...next.results].map((n) => n.id)),
      ).toEqual(new Set([id, lexical]));
      expect(
        [...result.results, ...next.results].some((n) => n.id === foreign),
      ).toBe(false);
      expect(provider.embed).toHaveBeenCalledTimes(1);
      await expect(
        service.searchByOwner(owner, {
          query: "changed",
          limit: 1,
          cursor: result.nextCursor!,
        }),
      ).rejects.toThrow("Invalid search cursor");
      await expect(
        service.searchByOwner("other-owner", {
          query,
          limit: 1,
          cursor: result.nextCursor!,
        }),
      ).rejects.toThrow("Invalid search cursor");
      expect(await repo.getByOwner("other-owner", id)).toBeNull();
      expect((await repo.getByOwner(owner, id))?.originalInput).toContain(
        "закрыть инвойс",
      );
    });
    it("keeps all DB-only lexical results when indexing/provider/budget is unavailable and respects filters", async () => {
      const owner = "fallback-" + randomUUID(),
        id = await seed(owner, "Invoice synthetic payment 🧪", basis(0)),
        repo = createSearchRepository(db);
      const down = {
        embed: async () => {
          throw new Error("synthetic private provider payload");
        },
      };
      const result = await createSearchService(
        repo,
        "s".repeat(32),
        down,
      ).searchByOwner(owner, { query: "Invoice", limit: 20 });
      expect(result).toMatchObject({
        mode: "lexical",
        degradation: "provider_unavailable",
        results: [{ id, channel: "api" }],
      });
      expect(JSON.stringify(result)).not.toContain("provider payload");
      expect(
        await repo.searchByOwner(owner, {
          query: "Invoice",
          tags: ["missing"],
        }),
      ).toEqual([]);
      expect(
        await repo.searchByOwner(owner, {
          query: "Invoice",
          start: "2027-01-01T00:00:00Z",
        }),
      ).toEqual([]);
      expect(
        (
          await repo.searchByOwner(owner, {
            query: "Invoice",
            project: "synthetic",
            kind: "memo",
          })
        )[0]?.id,
      ).toBe(id);
      await db.embeddingDailyBudget.updateMany({
        where: { ownerSubject: owner },
        data: { reservedTokens: 60000 },
      });
      const embed = vi.fn();
      const limited = await createSearchService(repo, "s".repeat(32), {
        embed,
      }).searchByOwner(owner, { query: "Invoice", limit: 20 });
      expect(limited.degradation).toBe("budget_exhausted");
      expect(embed).not.toHaveBeenCalled();
      const noIndexOwner = "unindexed-" + randomUUID();
      await seed(noIndexOwner, "Only lexical source");
      expect(
        (
          await createSearchService(repo, "s".repeat(32), {
            embed,
          }).searchByOwner(noIndexOwner, { query: "lexical", limit: 20 })
        ).degradation,
      ).toBe("unindexed");
    });
    it("excludes old model vectors and exposes only authenticated bounded POST search", async () => {
      const owner = "route-" + randomUUID(),
        id = await seed(owner, "Literal 100% _ paid", basis(0)),
        repo = createSearchRepository(db);
      await db.$executeRaw`UPDATE chunk_embeddings e SET "modelId"='obsolete' FROM note_chunks c WHERE c.id=e."chunkId" AND c."noteId"=${id}`;
      expect(await repo.hasIndex(owner)).toBe(false);
      const origin = "http://127.0.0.1:4310",
        auth = createSessionAuth(db, {
          mode: "dev-single-user",
          ownerSubject: owner,
          origin,
          issuer: "http://127.0.0.1:3110",
          audience: "http://127.0.0.1:3110/mcp",
          secure: false,
        });
      const app = createApp({
        config: {
          host: "127.0.0.1",
          port: 3110,
          environment: "test",
          requiresDatabase: false,
          corsOrigin: origin,
          auth: null,
        },
        dependencies: {
          sessionAuth: auth,
          search: createSearchService(repo, "s".repeat(32)),
        },
      });
      try {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/v1/search",
              payload: { query: "paid" },
            })
          ).statusCode,
        ).toBe(401);
        const login = await app.inject({
          method: "POST",
          url: "/auth/dev-session",
          headers: { origin },
          payload: {},
        });
        const cookie = login.cookies
            .map((c) => `${c.name}=${c.value}`)
            .join("; "),
          csrf = login.cookies.find((c) => c.name === "pce_csrf")!.value;
        const headers = { origin, cookie, "x-pce-csrf": csrf };
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/v1/search",
              headers,
              payload: { query: "paid", ownerSubject: "forged" },
            })
          ).statusCode,
        ).toBe(400);
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/search",
          headers,
          payload: { query: "100% _" },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().results[0]?.id).toBe(id);
        expect(
          (
            await app.inject({
              url: "/api/v1/search/notes/" + randomUUID(),
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(404);
      } finally {
        await app.close();
      }
    });
  },
);
