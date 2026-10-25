import {
  runResearchImportPass,
  researchIngressCheckpointKey,
} from "../../../apps/worker/src/research-ingress.js";
import { runEmbeddingPass } from "../../../apps/worker/src/embeddings.js";
import { createSearchService } from "../../../apps/api/src/search.js";
import {
  createResearchEmbeddingRepository,
  createSearchRepository,
} from "./index.js";
import { randomUUID } from "node:crypto";
import { createApp } from "../../../apps/api/src/app.js";
import { createSessionAuth } from "../../../apps/api/src/session-auth.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  createApiCaptureRepository,
  createResearchRepository,
} from "./index.js";

import type { ResearchArtifact } from "@pce/contracts";

function captureFixture() {
  const id = randomUUID(),
    capture = randomUUID();
  return {
    id,
    capture,
    markdown: `---
schema_version: 1
id: ${id}
capture_id: ${capture}
captured_at: 2026-10-22T11:00:00+02:00
source: chatgpt_text
kind: memo
domains: []
projects: []
tags: []
action_hint: none
review_required: false
title: Synthetic research parent
---

# Synthetic research parent

## Summary

Fixture note, no personal data.

## Original input

Research sample input
`,
  };
}
const url = process.env.PCE_DB_TEST_URL;
describe.skipIf(!url)("versioned research report persistence", () => {
  let db: PrismaClient;
  const owner = "research-" + randomUUID();
  const foreign = "foreign-" + randomUUID();
  const notes: string[] = [],
    captures: string[] = [];
  const note = async () => {
    const f = captureFixture();
    notes.push(f.id);
    captures.push(f.capture);
    await createApiCaptureRepository(db).persistByOwner(owner, {
      idempotencyKey: "research-note-" + f.id,
      notes: [f.markdown],
    });
    return f;
  };
  const artifact = (parent: {
    id: string;
    capture: string;
  }): ResearchArtifact => {
    const id = randomUUID();
    return {
      schemaVersion: 1,
      reportId: id,
      seriesId: id,
      revision: 1,
      supersedesReportId: null,
      parentNoteId: parent.id,
      captureId: parent.capture,
      title: "Synthetic sources",
      question: "What can be verified?",
      findings: "One fake source, explicitly marked synthetic.",
      limitations: ["Not real-world evidence"],
      researchedAt: "2026-10-22T10:00:00Z",
      status: "COMPLETE",
      provenance: { agent: "chatgpt", modelId: null },
      pceRetrieval: {
        outcome: "no_related_notes_found",
        queries: ["synthetic topic"],
        checkedAt: "2026-10-22T09:00:00Z",
        mode: "lexical",
        degradation: null,
      },
      sources: [
        {
          kind: "external",
          id: "synthetic-web",
          title: "Synthetic",
          checkedAt: "2026-10-22T09:01:00Z",
          url: "https://example.org/synthetic",
        },
      ],
      claims: [
        {
          id: "test-claim",
          classification: "sourced_fact",
          text: "Source test",
          sourceIds: ["synthetic-web"],
        },
      ],
    };
  };
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
  });
  afterAll(async () => {
    if (!db) return;
    await db.researchIngressAttempt.deleteMany({
      where: { ownerSubject: owner },
    });
    await db.embeddingDailyBudget.deleteMany({
      where: { ownerSubject: owner },
    });
    await db.embeddingScan.deleteMany({ where: { ownerSubject: owner } });
    await db.researchReport.deleteMany({ where: { ownerSubject: owner } });
    await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
    await db.dbProcessingJob.deleteMany({ where: { ownerSubject: owner } });
    await db.note.deleteMany({ where: { id: { in: notes } } });
    await db.capture.deleteMany({ where: { id: { in: captures } } });
    await db.$disconnect();
  });
  it("shares multilingual and identifier matching with note retrieval", async () => {
    const parent = await note(),
      reports = createResearchRepository(db);
    const report = {
      ...artifact(parent),
      title: "Observatory AX-912",
      findings: "Renew observatory permits. Починить театральные костюмы.",
    };
    await reports.persistByOwner(owner, { artifact: report });
    const search = createSearchRepository(db, true);
    for (const query of [
      "observatories permit",
      "театральными костюмами",
      "AX-912",
    ]) {
      expect(
        (await search.searchByOwner(owner, { query })).map((r) => r.id),
      ).toContain(report.reportId);
    }
    const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
    await createResearchEmbeddingRepository(db).prepareNote(
      report.reportId,
      owner,
    );
    const literal = JSON.stringify(vector);
    await db.$executeRaw`UPDATE research_embeddings e SET vector=${literal}::vector,status='READY' FROM research_chunks c WHERE c.id=e."chunkId" AND c."reportId"=${report.reportId} AND c."ownerSubject"=${owner}`;
    expect(
      (
        await search.searchByOwner(
          owner,
          { query: "celestial access permission" },
          vector,
        )
      ).map((r) => r.id),
    ).toContain(report.reportId);
    const unrelated = {
      ...artifact(parent),
      title: "Engine maintenance",
      findings: "Replace the motor in the workshop.",
    };
    await reports.persistByOwner(owner, { artifact: unrelated });
    await createResearchEmbeddingRepository(db).prepareNote(
      unrelated.reportId,
      owner,
    );
    const weak = JSON.stringify(
      Array.from({ length: 1536 }, (_, i) =>
        i === 0 ? 0.3 : i === 1 ? Math.sqrt(1 - 0.3 ** 2) : 0,
      ),
    );
    await db.$executeRaw`UPDATE research_embeddings e SET vector=${weak}::vector,status='READY' FROM research_chunks c WHERE c.id=e."chunkId" AND c."reportId"=${unrelated.reportId} AND c."ownerSubject"=${owner}`;
    expect(
      (await search.searchByOwner(owner, { query: "observatory" }, vector)).map(
        (r) => r.id,
      ),
    ).toContain(report.reportId);
    expect(
      (await search.searchByOwner(owner, { query: "observatory" }, vector)).map(
        (r) => r.id,
      ),
    ).not.toContain(unrelated.reportId);
    expect(
      (
        await search.searchByOwner(
          owner,
          { query: "What should I plan next?" },
          vector,
        )
      ).map((r) => r.id),
    ).toContain(unrelated.reportId);
    expect(
      (await search.searchByOwner(owner, { query: "AX-9120" }, vector)).map(
        (r) => r.id,
      ),
    ).not.toContain(report.reportId);
  });
  it("persists a report without changing Markdown, replays, and keeps successive versions", async () => {
    const parent = await note(),
      repo = createResearchRepository(db),
      first = artifact(parent);
    const before = await db.note.findUniqueOrThrow({
      where: { id: parent.id },
    });
    const replies = await Promise.all([
      repo.persistByOwner(owner, { artifact: first }),
      repo.persistByOwner(owner, { artifact: first }),
    ]);
    expect(replies.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(replies[0]).toMatchObject({
      indexing: "PENDING",
      parentNoteId: parent.id,
    });
    const next = {
      ...first,
      reportId: randomUUID(),
      revision: 2,
      supersedesReportId: first.reportId,
      findings: "Updated research, separate revision",
    };
    expect(
      (await repo.persistByOwner(owner, { artifact: next })).revision,
    ).toBe(2);
    expect(
      (await repo.listByNote(owner, parent.id))?.map((r) => r.revision).sort(),
    ).toEqual([1, 2]);
    expect(
      (await db.note.findUniqueOrThrow({ where: { id: parent.id } }))
        .originalInput,
    ).toBe(before.originalInput);
    expect(
      (await db.note.findUniqueOrThrow({ where: { id: parent.id } }))
        .contentHash,
    ).toBe(before.contentHash);
    await expect(
      repo.persistByOwner(owner, {
        artifact: { ...first, findings: "Mutation" },
      }),
    ).rejects.toThrow("Research conflict");
    expect(await repo.getByOwner(foreign, first.reportId)).toBeNull();
    expect(await repo.listByNote(foreign, parent.id)).toBeNull();
  });
  it("rejects unowned, mismatched, stale, and forged related-note references", async () => {
    const parent = await note(),
      repo = createResearchRepository(db),
      v = artifact(parent);
    await expect(repo.persistByOwner(foreign, { artifact: v })).rejects.toThrow(
      "Research conflict",
    );
    await expect(
      repo.persistByOwner(owner, {
        artifact: { ...v, captureId: randomUUID() },
      }),
    ).rejects.toThrow();
    const context = await note();
    const badCitation: ResearchArtifact = {
      ...v,
      pceRetrieval: { ...v.pceRetrieval, outcome: "searched" },
      sources: [
        {
          kind: "pce_note",
          id: "other-note",
          noteId: context.id,
          sourceRevision: "wrong",
          rationale: "Outdated",
        },
      ],
      claims: [
        {
          id: "test-claim",
          classification: "sourced_fact",
          text: "Cannot claim stale evidence",
          sourceIds: ["other-note"],
        },
      ],
    };
    await expect(
      repo.persistByOwner(owner, { artifact: badCitation }),
    ).rejects.toThrow("Research conflict");
    const current = await db.note.findUniqueOrThrow({
      where: { id: context.id },
    });
    expect(
      (
        await repo.persistByOwner(owner, {
          artifact: {
            ...badCitation,
            sources: [
              {
                ...badCitation.sources[0],
                sourceRevision: current.sourceRevision,
              },
            ],
          },
        })
      ).status,
    ).toBe("DB_PERSISTED");
  });
  it("authenticates and owner-scopes write, read and per-note history endpoints", async () => {
    const parent = await note(),
      v = artifact(parent);
    const origin = "http://127.0.0.1:4319";
    const auth = createSessionAuth(db, {
      mode: "dev-single-user",
      ownerSubject: owner,
      origin,
      issuer: "http://127.0.0.1:3119",
      audience: "http://127.0.0.1:3119/mcp",
      secure: false,
    });
    const app = createApp({
      config: {
        host: "127.0.0.1",
        port: 3119,
        environment: "test",
        corsOrigin: origin,
        requiresDatabase: false,
        auth: null,
      },
      dependencies: {
        sessionAuth: auth,
        research: createResearchRepository(db),
      },
    });
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/research/reports",
            payload: { artifact: v },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ url: `/api/v1/notes/${parent.id}/research` }))
          .statusCode,
      ).toBe(401);
      const login = await app.inject({
        method: "POST",
        url: "/auth/dev-session",
        headers: { origin },
        payload: {},
      });
      const cookie = login.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const csrf = login.cookies.find((c) => c.name === "pce_csrf")!.value;
      const headers = { origin, cookie, "x-pce-csrf": csrf };
      const token = await app.inject({
        method: "POST",
        url: "/auth/token",
        headers,
        payload: { scope: "notes:read" },
      });
      const readOnly = { authorization: "Bearer " + token.json().access_token };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/research/reports",
            headers: readOnly,
            payload: { artifact: v },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/research/reports",
            headers,
            payload: { artifact: v, ownerSubject: "forged" },
          })
        ).statusCode,
      ).toBe(400);
      const posted = await app.inject({
        method: "POST",
        url: "/api/v1/research/reports",
        headers,
        payload: { artifact: v },
      });
      expect(posted.statusCode).toBe(200);
      expect(posted.json()).toMatchObject({
        status: "DB_PERSISTED",
        indexing: "PENDING",
        reportId: v.reportId,
      });
      const record = await app.inject({
        url: `/api/v1/research/reports/${v.reportId}`,
        headers: readOnly,
      });
      expect(record.statusCode).toBe(200);
      expect(record.json().sources[0].url).toBe(
        "https://example.org/synthetic",
      );
      const history = await app.inject({
        url: `/api/v1/notes/${parent.id}/research`,
        headers: readOnly,
      });
      expect(history.json().reports).toHaveLength(1);
      expect(
        (
          await app.inject({
            url: `/api/v1/notes/${randomUUID()}/research`,
            headers: readOnly,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
      await db.authSession.deleteMany({ where: { ownerSubject: owner } });
    }
  });
  it("enforces exact allowlisted import path and idempotent replay", async () => {
    const parent = await note(),
      repo = createResearchRepository(db),
      v = artifact(parent);
    const bytes = JSON.stringify(v);
    await expect(
      repo.importByOwner(owner, bytes, "inbox/" + v.reportId + ".json", "abc"),
    ).rejects.toThrow();
    expect(
      (
        await repo.importByOwner(
          owner,
          bytes,
          `research/inbox/${v.reportId}.json`,
          "sha123",
        )
      ).replayed,
    ).toBe(false);
    expect(
      (
        await repo.importByOwner(
          owner,
          bytes,
          `research/inbox/${v.reportId}.json`,
          "sha123",
        )
      ).replayed,
    ).toBe(true);
    expect((await repo.getByOwner(owner, v.reportId))?.origin).toBe("github");
  });
  it("recovers partial note/report saves with durable retry, indexes and retrieves attributed research", async () => {
    const parent = captureFixture();
    notes.push(parent.id);
    captures.push(parent.capture);
    const v = artifact(parent);
    v.title = "Synthetic quasar evidence";
    v.findings = "Quasarbloom is a synthetic finding distinct from user input.";
    const path = `research/inbox/${v.reportId}.json`;
    const checkpointKey = researchIngressCheckpointKey(
      owner,
      "owner/synthetic",
      "main",
    );
    let now = new Date();
    const store = {
      listResearch: async () => ({ files: [{ path, revision: "abc123" }] }),
      readResearch: async () => ({
        path,
        revision: "abc123",
        content: JSON.stringify(v),
      }),
    };
    const pass = () =>
      runResearchImportPass({
        db,
        store,
        ownerSubject: owner,
        checkpointKey,
        now: () => now,
      });
    expect(await pass()).toMatchObject({ deferred: 1, imported: 0 });
    expect(
      await db.researchIngressAttempt.findFirst({ where: { checkpointKey } }),
    ).toMatchObject({ status: "RETRY", attemptCount: 1 });
    await createApiCaptureRepository(db).persistByOwner(owner, {
      idempotencyKey: parent.id,
      notes: [parent.markdown],
    });
    const original = await db.note.findUniqueOrThrow({
      where: { id: parent.id },
    });
    const repo = createResearchRepository(db);
    expect(await repo.importsByNote(owner, parent.id)).toMatchObject([
      { status: "RETRY" },
    ]);
    expect(await pass()).toMatchObject({ deferred: 1, imported: 0 });
    now = new Date(now.getTime() + 20000);
    expect(await pass()).toMatchObject({ imported: 1 });
    expect(await pass()).toMatchObject({ replayed: 1 });
    expect(await repo.importsByNote(owner, parent.id)).toMatchObject([
      { status: "IMPORTED", attemptCount: 2 },
    ]);
    expect(
      (await db.note.findUniqueOrThrow({ where: { id: parent.id } })).body,
    ).toBe(original.body);
    const search = createSearchRepository(db, true);
    const keyword = await search.searchByOwner(owner, { query: "Quasarbloom" });
    expect(keyword).toMatchObject([
      {
        id: v.reportId,
        parentNoteId: parent.id,
        contentType: "research",
        lexical: true,
        semantic: false,
      },
    ]);
    expect(
      await createSearchRepository(db).searchByOwner(owner, {
        query: "Quasarbloom",
      }),
    ).toEqual([]);
    expect(
      await search.searchByOwner("other-owner", { query: "Quasarbloom" }),
    ).toEqual([]);
    const queue = createResearchEmbeddingRepository(db);
    await queue.prepareNote(v.reportId, owner);
    const vector = new Array(1536).fill(0);
    vector[0] = 1;
    const leased = await queue.claim(owner, "test-worker", now);
    expect(leased).not.toBeNull();
    expect(
      await queue.complete(
        "other-owner",
        "test-worker",
        leased!.id,
        vector,
        10,
        now,
      ),
    ).toBe(false);
    expect(
      await queue.complete(owner, "other-worker", leased!.id, vector, 10, now),
    ).toBe(false);
    expect(
      await queue.complete(owner, "test-worker", leased!.id, vector, 10, now),
    ).toBe(true);
    expect((await repo.getByOwner(owner, v.reportId))?.indexing).toBe("READY");
    const service = createSearchService(search, "s".repeat(32), {
      embed: async () => ({ vector, usageTokens: 10 }),
    });
    const semantic = await service.searchByOwner(owner, {
      query: "Unrelatedlexeme",
      limit: 20,
    });
    expect(semantic.mode).toBe("hybrid");
    expect(semantic.results.find((r) => r.id === v.reportId)).toMatchObject({
      contentType: "research",
      semantic: true,
      lexical: false,
      parentNoteId: parent.id,
    });
    const degraded = createSearchService(search, "s".repeat(32), {
      embed: async () => {
        throw new Error("Synthetic provider failure");
      },
    });
    expect(
      await degraded.searchByOwner(owner, { query: "Quasarbloom", limit: 20 }),
    ).toMatchObject({
      mode: "lexical",
      degradation: "provider_unavailable",
      results: [{ id: v.reportId }],
    });
    expect(
      (await repo.importByOwner(owner, JSON.stringify(v), path, "abc123"))
        .indexing,
    ).toBe("READY");
    await db.researchEmbedding.updateMany({
      where: { chunk: { reportId: v.reportId } },
      data: { modelId: "incompatible-model" },
    });
    expect((await repo.getByOwner(owner, v.reportId))?.indexing).toBe(
      "PENDING",
    );
    await db.researchEmbedding.updateMany({
      where: { chunk: { reportId: v.reportId } },
      data: { modelId: "text-embedding-3-small" },
    });
    const oldReservation = await queue.reservedTokensToday(owner, now);
    const second = artifact(parent);
    await repo.persistByOwner(owner, { artifact: second });
    const embedding = await runEmbeddingPass({
      queue,
      ownerSubject: owner,
      provider: {
        embed: async () => {
          throw new Error("synthetic outage");
        },
      },
      now: () => now,
    });
    expect(embedding.retry).toBeGreaterThan(0);
    expect(await queue.reservedTokensToday(owner, now)).toBeGreaterThan(
      oldReservation,
    );
    await db.ingestionCheckpoint.delete({ where: { key: checkpointKey } });
  });
});
