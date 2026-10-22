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
    await db.researchReport.deleteMany({ where: { ownerSubject: owner } });
    await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
    await db.dbProcessingJob.deleteMany({ where: { ownerSubject: owner } });
    await db.note.deleteMany({ where: { id: { in: notes } } });
    await db.capture.deleteMany({ where: { id: { in: captures } } });
    await db.$disconnect();
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
      indexing: "NOT_INDEXED",
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
        indexing: "NOT_INDEXED",
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
});
