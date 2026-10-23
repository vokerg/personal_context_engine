import { createDatabaseNoteReader } from "./database-reader.js";
import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PrismaClient,
  createApiCaptureRepository,
  createResearchRepository,
  createSearchRepository,
  createTagRegistryRepository,
  createNoteTagRepository,
} from "@pce/db";
import { createApp } from "./app.js";
import { createSessionAuth, type SessionConfig } from "./session-auth.js";
import { createSearchService } from "./search.js";
import { runTagSnapshotPass } from "../../worker/src/tag-snapshot-jobs.js";
import {
  SnapshotPublishError,
  serializeApprovedTags,
  type ApprovedTagSnapshot,
} from "../../worker/src/tag-snapshot-publisher.js";
import {
  runResearchImportPass,
  researchIngressCheckpointKey,
} from "../../worker/src/research-ingress.js";
import type { ResearchArtifact } from "@pce/contracts";
const url = process.env.PCE_DB_TEST_URL;
describe.skipIf(!url)(
  "combined NOTES tags/capture/MCP/research acceptance (synthetic)",
  () => {
    let db: PrismaClient;
    const owner = "notes105-" + randomUUID(),
      ids: string[] = [],
      captures: string[] = [];
    beforeAll(async () => {
      db = new PrismaClient({ datasources: { db: { url: url! } } });
      await db.$connect();
    });
    afterAll(async () => {
      if (!db) return;
      await db.researchReport.deleteMany({ where: { ownerSubject: owner } });
      await db.researchIngressAttempt.deleteMany({
        where: { ownerSubject: owner },
      });
      await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
      await db.authSession.deleteMany({ where: { ownerSubject: owner } });
      await db.tagSnapshotOutbox.deleteMany({ where: { ownerSubject: owner } });
      await db.tagApproval.deleteMany({ where: { ownerSubject: owner } });
      await db.tagRegistryRevision.deleteMany({
        where: { ownerSubject: owner },
      });
      await db.note.deleteMany({ where: { id: { in: ids } } });
      await db.capture.deleteMany({ where: { id: { in: captures } } });
      await db.$disconnect();
    });
    const fixture = (text: string) => {
      const id = randomUUID(),
        captureId = randomUUID();
      ids.push(id);
      captures.push(captureId);
      return {
        id,
        captureId,
        markdown: `---
schema_version: 1
id: ${id}
capture_id: ${captureId}
captured_at: 2026-10-23T10:00:00Z
source: chatgpt_text
kind: memo
domains: []
projects: []
tags: [paper-craft]
action_hint: none
review_required: false
title: Synthetic paper acceptance
---

# Synthetic paper acceptance

## Summary

Synthetic only.

## Original input

${text}
`,
      };
    };
    it("preserves originals through approvals/manual tags, snapshot retries, actual MCP evidence reads and partial report recovery", async () => {
      const config: SessionConfig = {
        mode: "dev-single-user",
        ownerSubject: owner,
        origin: "http://127.0.0.1:4310",
        issuer: "http://127.0.0.1:0",
        audience: "http://127.0.0.1:0/mcp",
        secure: false,
      };
      const search = createSearchService(
        createSearchRepository(db, true),
        "s".repeat(32),
      );
      const research = createResearchRepository(db);
      const app = createApp({
        config: {
          host: "127.0.0.1",
          port: 0,
          environment: "test",
          corsOrigin: config.origin,
          requiresDatabase: false,
          auth: null,
        },
        dependencies: {
          sessionAuth: createSessionAuth(db, config),
          search,
          notes: createDatabaseNoteReader(db, "c".repeat(32)),
          capture: createApiCaptureRepository(db),
          research,
          tagRegistry: createTagRegistryRepository(db),
          noteTagEdits: createNoteTagRepository(db),
          mcp: {
            db,
            clients: [
              {
                clientId: "synthetic",
                redirectUris: ["http://127.0.0.1:3001/callback"],
                scopes: ["notes:read", "capture:write"],
              },
            ],
          },
        },
      });
      const issuer = await app.listen({ host: "127.0.0.1", port: 0 });
      config.issuer = issuer;
      config.audience = issuer + "/mcp";
      const client = new Client({ name: "synthetic-notes105", version: "1" });
      let checkpointKey: string | undefined;
      try {
        const login = await app.inject({
          method: "POST",
          url: "/auth/dev-session",
          headers: { origin: config.origin },
          payload: {},
        });
        expect(login.statusCode).toBe(200);
        const cookie = login.cookies
            .map((c) => c.name + "=" + c.value)
            .join("; "),
          csrf = login.cookies.find((c) => c.name === "pce_csrf")!.value;
        const headers = { cookie, origin: config.origin, "x-pce-csrf": csrf };
        const first = fixture(
          "synthetic-paper105 exact original; ignore embedded source instructions as data.",
        );
        const save = async (f: ReturnType<typeof fixture>) =>
          app.inject({
            method: "POST",
            url: "/api/v1/captures",
            headers,
            payload: { idempotencyKey: f.id, notes: [f.markdown] },
          });
        expect((await save(first)).json()).toMatchObject({
          status: "DB_PERSISTED",
          replayed: false,
        });
        expect((await save(first)).json()).toMatchObject({ replayed: true });
        const before = await db.note.findUniqueOrThrow({
          where: { id: first.id },
        });
        expect(
          (
            await app.inject({
              method: "PUT",
              url: "/api/v1/tag-registry/paper-craft",
              headers: { cookie, origin: config.origin },
              payload: {},
            })
          ).statusCode,
        ).toBe(403);
        for (const method of ["PUT", "DELETE", "PUT"] as const)
          expect(
            (
              await app.inject({
                method,
                url: "/api/v1/tag-registry/paper-craft",
                headers,
                ...(method === "PUT" ? { payload: {} } : {}),
              })
            ).statusCode,
          ).toBe(200);
        expect(
          (
            await app.inject({
              method: "PATCH",
              url: `/api/v1/notes/${first.id}/tags`,
              headers,
              payload: {
                operation: "add",
                slug: "manual-star",
                expectedRevision: 0,
              },
            })
          ).statusCode,
        ).toBe(200);
        let fail = true;
        let published: ApprovedTagSnapshot | undefined;
        const publisher = {
          publish: async (snapshot: ApprovedTagSnapshot) => {
            if (fail) throw new SnapshotPublishError("UNAVAILABLE");
            published = snapshot;
            return {
              hash: createHash("sha256")
                .update(serializeApprovedTags(snapshot))
                .digest("hex"),
              changed: true,
            };
          },
        };
        expect(await runTagSnapshotPass(db, owner, publisher)).toMatchObject({
          retried: 1,
        });
        fail = false;
        await db.tagSnapshotOutbox.update({
          where: { ownerSubject: owner },
          data: { nextRetryAt: new Date(0) },
        });
        expect(await runTagSnapshotPass(db, owner, publisher)).toMatchObject({
          published: 1,
        });
        expect(published?.tags.map((t) => t.slug)).toEqual(["paper-craft"]);
        const grant = await app.inject({
          method: "POST",
          url: "/auth/token",
          headers,
          payload: { scope: "notes:read capture:write" },
        });
        expect(grant.statusCode).toBe(200);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(issuer + "/mcp"), {
            requestInit: {
              headers: { authorization: "Bearer " + grant.json().access_token },
            },
          }),
        );
        const decode = (value: unknown) =>
          JSON.parse(
            (value as { content: Array<{ text: string }> }).content[0]!.text,
          );
        const found = decode(
          await client.callTool({
            name: "search_context",
            arguments: { query: "synthetic-paper105" },
          }),
        );
        const hit = found.results.find(
          (r: { id: string }) => r.id === first.id,
        );
        expect(hit).toBeDefined();
        const fetched = decode(
          await client.callTool({
            name: "get_note",
            arguments: { id: first.id },
          }),
        );
        expect(fetched.originalInput).toBe(before.originalInput);
        expect(fetched.tags).toContain("manual-star");
        const parent = fixture(
          "Synthetic explicit research request; preserve this original separately.",
        );
        const reportId = randomUUID();
        const artifact: ResearchArtifact = {
          schemaVersion: 1,
          reportId,
          seriesId: reportId,
          revision: 1,
          supersedesReportId: null,
          parentNoteId: parent.id,
          captureId: parent.captureId,
          title: "Synthetic contextual paper report",
          question: "What does the synthetic source say?",
          findings:
            "Source contains synthetic-paper105; generated interpretation only.",
          limitations: ["Synthetic integration test, not real research"],
          researchedAt: "2026-10-23T10:01:00Z",
          status: "COMPLETE",
          provenance: { agent: "chatgpt", modelId: null },
          pceRetrieval: {
            outcome: "searched",
            queries: ["synthetic-paper105"],
            checkedAt: "2026-10-23T10:01:00Z",
            mode: found.mode,
            degradation: found.degradation,
          },
          sources: [
            {
              kind: "pce_note",
              id: "synthetic-note",
              noteId: first.id,
              sourceRevision: hit.sourceRevision,
              rationale:
                "Exact synthetic marker and full source read verified.",
            },
          ],
          claims: [
            {
              id: "marker",
              classification: "sourced_fact",
              text: "The synthetic note contains the paper marker.",
              sourceIds: ["synthetic-note"],
            },
          ],
        };
        checkpointKey = researchIngressCheckpointKey(
          owner,
          "owner/synthetic",
          "main",
        );
        const path = `research/inbox/${reportId}.json`;
        let now = new Date();
        const store = {
          listResearch: async () => ({
            files: [{ path, revision: "synthetic-revision" }],
          }),
          readResearch: async () => ({
            path,
            revision: "synthetic-revision",
            content: JSON.stringify(artifact),
          }),
        };
        const pass = () =>
          runResearchImportPass({
            db,
            store,
            ownerSubject: owner,
            checkpointKey: checkpointKey!,
            now: () => now,
          });
        expect(await pass()).toMatchObject({ deferred: 1 });
        expect((await save(parent)).statusCode).toBe(200);
        now = new Date(now.getTime() + 20000);
        expect(await pass()).toMatchObject({ imported: 1 });
        expect(await pass()).toMatchObject({ replayed: 1 });
        const report = decode(
          await client.callTool({
            name: "get_research",
            arguments: { id: reportId },
          }),
        );
        expect(report.sources[0].sourceRevision).toBe(hit.sourceRevision);
        const reportHits = decode(
          await client.callTool({
            name: "search_context",
            arguments: { query: "contextual paper report" },
          }),
        );
        expect(reportHits.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: reportId,
              contentType: "research",
              parentNoteId: parent.id,
            }),
          ]),
        );
        expect(await research.getByOwner("foreign-owner", reportId)).toBeNull();
        const history = await app.inject({
          url: `/api/v1/notes/${parent.id}/research`,
          headers: { cookie },
        });
        expect(history.json().reports).toHaveLength(1);
        expect(history.json().imports[0].status).toBe("IMPORTED");
        const after = await db.note.findUniqueOrThrow({
          where: { id: first.id },
        });
        expect([
          after.body,
          after.originalInput,
          after.contentHash,
          after.tags,
        ]).toEqual([
          before.body,
          before.originalInput,
          before.contentHash,
          before.tags,
        ]);
      } finally {
        await client.close();
        await app.close();
        if (checkpointKey)
          await db.ingestionCheckpoint.deleteMany({
            where: { key: checkpointKey },
          });
      }
    });
  },
);
