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
    async function seed(owner: string, original: string, vector?: number[]) {
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
title: Synthetic source
---

# Synthetic source

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
    it("finds a no-shared-word Russian finance source through vectors, fuses lexical matches and excludes foreign owners", async () => {
      const owner = "search-" + randomUUID(),
        id = await seed(owner, "закрыть инвойс", basis(0));
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
