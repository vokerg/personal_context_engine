import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PrismaClient,
  acquireGitHubArtifacts,
  processStagingPass,
  githubFetchConfig,
  createGitHubSyncService,
  GitHubContentStore,
  createNoteRepository,
} from "./index.js";
import { createApp } from "../../../apps/api/src/app.js";
import { createSessionAuth } from "../../../apps/api/src/session-auth.js";
import { runDbJobPass } from "../../../apps/worker/src/db-jobs.js";

const url = process.env.PCE_DB_TEST_URL;
const options = {
  repository: "synthetic/private",
  branch: "main",
  token: "synthetic-server-only",
};
const fixture = () => {
  const id = randomUUID(),
    capture = randomUUID();
  const content = `---
schema_version: 1
id: ${id}
capture_id: ${capture}
captured_at: 2026-10-20T09:00:00+02:00
source: chatgpt_text
kind: memo
domains: []
projects: []
tags: []
action_hint: none
review_required: false
title: Synthetic staging
---

# Synthetic staging

## Summary

Synthetic summary.

## Original input

Buy filters.  
Keep whitespace.\t
`;
  return { id, capture, path: `inbox/2026-10-20_${id}.md`, content };
};
const revision = (bytes: Uint8Array) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

/** Exercise the actual adapter with immutable synthetic Git objects. Reject ALL writes. */
function github(files: Array<{ path: string; bytes: Buffer; mode?: string }>) {
  const calls: string[] = [];
  const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(
      "/repos/synthetic/private",
      "",
    );
    calls.push(init?.method ?? "GET");
    if (init?.method && init.method !== "GET")
      throw new Error("GitHub write forbidden");
    let body: unknown;
    if (path === "") body = { private: true };
    else if (path.startsWith("/git/ref/"))
      body = { object: { sha: "a".repeat(40) } };
    else if (path.startsWith("/git/commits/"))
      body = { tree: { sha: "b".repeat(40) } };
    else if (path.startsWith("/git/trees/"))
      body = {
        truncated: false,
        tree: files.map((f) => ({
          path: f.path,
          mode: f.mode ?? "100644",
          type: "blob",
          sha: revision(f.bytes),
          size: f.bytes.length,
        })),
      };
    else if (path.startsWith("/git/blobs/")) {
      const file = files.find(
        (f) => revision(f.bytes) === path.split("/").at(-1),
      );
      if (!file) return new Response("{}", { status: 404 });
      body = {
        encoding: "base64",
        content: file.bytes.toString("base64"),
        size: file.bytes.length,
      };
    } else throw new Error("Unexpected synthetic request");
    return new Response(JSON.stringify(body));
  });
  return {
    store: new GitHubContentStore({ ...options, fetch: http }),
    calls,
    http,
  };
}

describe.skipIf(!url)("two-stage shared GitHub ingestion", () => {
  let db: PrismaClient;
  const owners: string[] = [],
    captures: string[] = [];
  const owner = () => {
    const value = "staging-" + randomUUID();
    owners.push(value);
    return value;
  };
  const note = () => {
    const f = fixture();
    captures.push(f.capture);
    return f;
  };
  async function stage(
    subject: string,
    path: string,
    content: string | Buffer,
  ) {
    const fake = github([
      {
        path,
        bytes: Buffer.isBuffer(content) ? content : Buffer.from(content),
      },
    ]);
    const result = await acquireGitHubArtifacts(db, subject, options, {
      store: fake.store,
    });
    expect(fake.calls.every((c) => c === "GET")).toBe(true);
    return result;
  }
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
  });
  afterAll(async () => {
    if (!db) return;
    const where = { ownerSubject: { in: owners } };
    for (const table of [
      db.authSession,
      db.ingestionStaging,
      db.taskIngressAttempt,
      db.researchIngressAttempt,
      db.taskCommand,
      db.taskEvent,
      db.taskSource,
      db.taskExtractionBatch,
      db.task,
      db.researchReport,
      db.note,
    ] as const)
      await table.deleteMany({ where });
    await db.capture.deleteMany({ where: { id: { in: captures } } });
    await db.$disconnect();
  });

  it("preserves UTF-8 BOM, CRLF, spaces and invalid bytes before domain validation", async () => {
    const subject = owner(),
      f = note();
    const raw = Buffer.from("\ufeff" + f.content.replaceAll("\n", "\r\n"));
    expect(await stage(subject, f.path, raw)).toMatchObject({ staged: 1 });
    const row = await db.ingestionStaging.findFirstOrThrow({
      where: { ownerSubject: subject },
    });
    expect(Buffer.from(row.rawContent).equals(raw)).toBe(true);
    expect(row.contentHash).toBe(
      createHash("sha256").update(raw).digest("hex"),
    );
    expect(await db.note.count({ where: { ownerSubject: subject } })).toBe(0);
    expect(
      await db.dbProcessingJob.count({ where: { ownerSubject: subject } }),
    ).toBe(0);
    const bad = Buffer.from([0xff, 0x00, 0xfe]);
    await stage(subject, "inbox/invalid.md", bad);
    await processStagingPass(db, subject);
    const invalid = await db.ingestionStaging.findFirstOrThrow({
      where: { ownerSubject: subject, sourcePath: "inbox/invalid.md" },
    });
    expect(invalid.status).toBe("INVALID");
    expect(Buffer.from(invalid.rawContent).equals(bad)).toBe(true);
  });

  it("deduplicates simultaneous API/Mac acquisition, imports once and prepares chunks without GitHub", async () => {
    const subject = owner(),
      f = note();
    const source = [{ path: f.path, bytes: Buffer.from(f.content) }];
    const results = await Promise.all([
      acquireGitHubArtifacts(db, subject, options, {
        store: github(source).store,
      }),
      acquireGitHubArtifacts(db, subject, options, {
        store: github(source).store,
      }),
    ]);
    expect(results.reduce((n, r) => n + r.staged, 0)).toBe(1);
    expect(await stage(subject, f.path, f.content)).toMatchObject({
      staged: 0,
      alreadyStaged: 1,
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("GitHub unreachable"));
    try {
      expect(
        githubFetchConfig({ PCE_GITHUB_FETCH_ENABLED: "false" }),
      ).toBeNull();
      const reports = await Promise.all([
        processStagingPass(db, subject, { workerId: "mac" }),
        processStagingPass(db, subject, { workerId: "gcp" }),
      ]);
      expect(reports.reduce((n, r) => n + r.processed, 0)).toBe(1);
      expect(await db.note.count({ where: { ownerSubject: subject } })).toBe(1);
      const imported = await db.note.findUniqueOrThrow({ where: { id: f.id } });
      expect(imported.sourceRevision).toBe(revision(Buffer.from(f.content)));
      expect(imported.sourcePath).toBe(f.path);
      expect(imported.state).toBe("PERSISTED");
      expect(imported.canonicalPath).toBeNull();
      expect(await runDbJobPass(db, subject)).toMatchObject({ prepared: 1 });
      expect(
        await db.noteChunk.count({ where: { ownerSubject: subject } }),
      ).toBeGreaterThan(0);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it("starts the actual DB-jobs worker without a GitHub token and preserves owner isolation", async () => {
    const subject = owner(),
      foreign = owner(),
      f = note();
    await stage(subject, f.path, f.content);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [new URL("../../../apps/worker/dist/main.js", import.meta.url).pathname],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: url!,
          PCE_OWNER_SUBJECT: subject,
          WORKER_MODE: "db-jobs-once",
          PCE_GITHUB_FETCH_ENABLED: "false",
          PCE_TAG_SNAPSHOT_ENABLED: "false",
          PCE_TASK_INGRESS_ENABLED: "false",
          PCE_RESEARCH_INGRESS_ENABLED: "false",
          PCE_RESEARCH_REPORTS: "false",
          PCE_EMBEDDINGS_ENABLED: "false",
        },
        timeout: 15000,
      },
    );
    expect(stdout).toContain('"processed":1');
    expect(stdout).toContain('"prepared":1');
    expect(stdout).not.toContain(f.content);
    await stage(foreign, f.path, f.content);
    expect(await processStagingPass(db, foreign)).toMatchObject({ invalid: 1 });
    expect(
      (await db.note.findUniqueOrThrow({ where: { id: f.id } })).ownerSubject,
    ).toBe(subject);
  });

  it("retains changed revisions as conflicts and replays legacy finalized sources without edits", async () => {
    const subject = owner(),
      f = note();
    await createNoteRepository(db).importMarkdown({
      markdown: f.content,
      sourcePath: f.path,
      sourceRevision: revision(Buffer.from(f.content)),
      ownerSubject: subject,
    });
    await db.note.update({
      where: { id: f.id },
      data: { state: "FINALIZED", canonicalPath: `notes/2026/10/${f.id}.md` },
    });
    await stage(subject, `notes/2026/10/${f.id}.md`, f.content);
    expect(await processStagingPass(db, subject)).toMatchObject({
      processed: 1,
    });
    await stage(subject, f.path, f.content + "Changed revision\n");
    expect(await processStagingPass(db, subject)).toMatchObject({ invalid: 1 });
    const prior = await db.note.findUniqueOrThrow({ where: { id: f.id } });
    expect(prior.state).toBe("FINALIZED");
    expect(prior.contentHash).toBe(
      createHash("sha256").update(f.content).digest("hex"),
    );
    expect(
      await db.ingestionStaging.count({ where: { ownerSubject: subject } }),
    ).toBe(2);
    // Missing sources are never interpreted as deletion.
    await acquireGitHubArtifacts(db, subject, options, {
      store: github([]).store,
    });
    expect(await db.note.count({ where: { ownerSubject: subject } })).toBe(1);
  });

  it("recovers expired claims before persistence and committed import before acknowledgement", async () => {
    const subject = owner(),
      f = note();
    await stage(subject, f.path, f.content);
    const row = await db.ingestionStaging.findFirstOrThrow({
      where: { ownerSubject: subject },
    });
    await db.ingestionStaging.update({
      where: { id: row.id },
      data: {
        status: "LEASED",
        leaseOwner: "dead-before-persist",
        leaseUntil: new Date(0),
        attemptCount: 1,
      },
    });
    const interrupted = await processStagingPass(db, subject, {
      afterPersist: async () => {
        throw new Error("Simulated process failure");
      },
    });
    expect(interrupted).toMatchObject({ processed: 0, retried: 1 });
    expect(await db.note.count({ where: { ownerSubject: subject } })).toBe(1);
    expect(
      await db.dbProcessingJob.count({ where: { ownerSubject: subject } }),
    ).toBe(0);
    await db.ingestionStaging.update({
      where: { id: row.id },
      data: { nextRetryAt: new Date(0) },
    });
    expect(await processStagingPass(db, subject)).toMatchObject({
      processed: 1,
    });
    expect(
      await db.dbProcessingJob.count({ where: { ownerSubject: subject } }),
    ).toBe(1);
    const done = await db.ingestionStaging.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(done.processedAt).not.toBeNull();
    expect(done.canonicalId).toBe(f.id);
  });

  it("fences an expired worker after canonical commit and reclaims the unacknowledged import", async () => {
    const subject = owner(),
      f = note();
    await stage(subject, f.path, f.content);
    const row = await db.ingestionStaging.findFirstOrThrow({
      where: { ownerSubject: subject },
    });
    await processStagingPass(db, subject, {
      limit: 1,
      workerId: "crashed",
      afterPersist: async () => {
        await db.ingestionStaging.update({
          where: { id: row.id },
          data: { leaseUntil: new Date(0) },
        });
        throw new Error("Simulated death after canonical commit");
      },
    });
    expect(
      (await db.ingestionStaging.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("LEASED");
    expect(
      await db.dbProcessingJob.count({ where: { ownerSubject: subject } }),
    ).toBe(0);
    expect(
      await processStagingPass(db, subject, { workerId: "replacement" }),
    ).toMatchObject({ processed: 1 });
    expect(await db.note.count({ where: { ownerSubject: subject } })).toBe(1);
    expect(
      await db.dbProcessingJob.count({ where: { ownerSubject: subject } }),
    ).toBe(1);
  });

  it("rolls back acknowledgement on temporary job-write failure and repairs on retry", async () => {
    const subject = owner(),
      f = note();
    await stage(subject, f.path, f.content);
    // Synthetic DB trigger faults only this owner's queue insert, after the canonical commit.
    await db.$executeRawUnsafe(
      `CREATE FUNCTION staging_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."ownerSubject" = '${subject}' THEN RAISE EXCEPTION 'synthetic temporary DB failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER staging_test_fail BEFORE INSERT ON db_processing_jobs FOR EACH ROW EXECUTE FUNCTION staging_test_fail()",
    );
    try {
      expect(await processStagingPass(db, subject)).toMatchObject({
        processed: 0,
        retried: 1,
      });
    } finally {
      await db.$executeRawUnsafe(
        "DROP TRIGGER staging_test_fail ON db_processing_jobs",
      );
      await db.$executeRawUnsafe("DROP FUNCTION staging_test_fail()");
    }
    const row = await db.ingestionStaging.findFirstOrThrow({
      where: { ownerSubject: subject },
    });
    expect(row.processedAt).toBeNull();
    expect(row.status).toBe("RETRY");
    await db.ingestionStaging.update({
      where: { id: row.id },
      data: { nextRetryAt: new Date(0) },
    });
    expect(await processStagingPass(db, subject)).toMatchObject({
      processed: 1,
    });
  });

  it("imports tasks and research with deferred missing parents using established contracts", async () => {
    const subject = owner(),
      f = note(),
      batchId = randomUUID(),
      reportId = randomUUID();
    const taskId = randomUUID();
    const batch = {
      schemaVersion: 1,
      batchId,
      captureId: f.capture,
      sourceNoteIds: [f.id],
      classifier: {
        method: "explicit",
        policyVersion: "tasks-v1",
        agent: "synthetic",
      },
      tasks: [
        {
          taskId,
          title: "Buy filters",
          sources: [
            { noteId: f.id, captureId: f.capture, evidence: "Buy filters." },
          ],
        },
      ],
    };
    const report = {
      schemaVersion: 1,
      reportId,
      seriesId: reportId,
      revision: 1,
      supersedesReportId: null,
      parentNoteId: f.id,
      captureId: f.capture,
      title: "Synthetic sources",
      question: "What can be verified?",
      findings: "Synthetic finding.",
      limitations: ["Synthetic only"],
      researchedAt: "2026-10-22T10:00:00Z",
      status: "COMPLETE",
      provenance: { agent: "chatgpt", modelId: null },
      pceRetrieval: {
        outcome: "no_related_notes_found",
        queries: ["synthetic"],
        checkedAt: "2026-10-22T09:00:00Z",
        mode: "lexical",
        degradation: null,
      },
      sources: [
        {
          kind: "external",
          id: "synthetic",
          title: "Synthetic",
          checkedAt: "2026-10-22T09:01:00Z",
          url: "https://example.org/synthetic",
        },
      ],
      claims: [
        {
          id: "claim",
          classification: "sourced_fact",
          text: "Synthetic",
          sourceIds: ["synthetic"],
        },
      ],
    };
    await stage(subject, `tasks/inbox/${batchId}.json`, JSON.stringify(batch));
    await stage(
      subject,
      `research/inbox/${reportId}.json`,
      JSON.stringify(report),
    );
    expect(await processStagingPass(db, subject)).toMatchObject({ retried: 2 });
    await stage(subject, f.path, f.content);
    await db.ingestionStaging.updateMany({
      where: { ownerSubject: subject, status: "RETRY" },
      data: { nextRetryAt: new Date(0) },
    });
    await processStagingPass(db, subject);
    await db.ingestionStaging.updateMany({
      where: { ownerSubject: subject, status: "RETRY" },
      data: { nextRetryAt: new Date(0) },
    });
    await processStagingPass(db, subject);
    expect(await db.task.count({ where: { ownerSubject: subject } })).toBe(1);
    expect(
      await db.taskExtractionBatch.count({ where: { ownerSubject: subject } }),
    ).toBe(1);
    expect(
      await db.researchReport.count({ where: { ownerSubject: subject } }),
    ).toBe(1);
    expect(
      await db.ingestionStaging.count({
        where: { ownerSubject: subject, status: "PROCESSED" },
      }),
    ).toBe(3);
  });

  it("bounds scans, advances past unsafe sources and resumes the same persisted cursor", async () => {
    const subject = owner(),
      a = note(),
      b = note();
    const files = [
      {
        path: "inbox/000-unsafe.md",
        bytes: Buffer.from("synthetic"),
        mode: "120000",
      },
      { path: a.path, bytes: Buffer.from(a.content) },
      { path: b.path, bytes: Buffer.from(b.content) },
    ];
    const first = await acquireGitHubArtifacts(db, subject, options, {
      store: github(files).store,
      limit: 1,
    });
    expect(first).toMatchObject({ examined: 1, failed: 1, hasMore: true });
    expect(
      await acquireGitHubArtifacts(db, subject, options, {
        store: github(files).store,
        limit: 1,
      }),
    ).toMatchObject({ examined: 1, staged: 1, hasMore: true });
    expect(
      await acquireGitHubArtifacts(db, subject, options, {
        store: github(files).store,
        limit: 1,
      }),
    ).toMatchObject({ examined: 1, staged: 1, hasMore: false });
    expect(
      await createGitHubSyncService(db, subject, options).status(subject),
    ).toMatchObject({ lastSuccessfulScan: null, pending: 2 });
  });

  it("runs bounded repeated HTTP sync through the same fetcher as Mac acquisition", async () => {
    const subject = owner(),
      f = note();
    const source = github([{ path: f.path, bytes: Buffer.from(f.content) }]);
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(source.http);
    const authConfig = {
      mode: "dev-single-user" as const,
      ownerSubject: subject,
      origin: "http://127.0.0.1:4310",
      issuer: "http://127.0.0.1:3110",
      audience: "pce",
      secure: false,
    };
    const app = createApp({
      config: {
        host: "127.0.0.1",
        port: 3110,
        environment: "test",
        corsOrigin: authConfig.origin,
        requiresDatabase: false,
        auth: null,
      },
      dependencies: {
        sessionAuth: createSessionAuth(db, authConfig),
        githubSync: createGitHubSyncService(db, subject, options),
      },
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/auth/dev-session",
        headers: { origin: authConfig.origin },
        payload: {},
      });
      const cookie = login.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const csrf = login.cookies.find((c) => c.name === "pce_csrf")!.value;
      const headers = { cookie, origin: authConfig.origin, "x-pce-csrf": csrf };
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/github-sync",
        headers,
        payload: {},
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ examined: 1, staged: 1 });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/github-sync",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(429);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
      try {
        const second = await app.inject({
          method: "POST",
          url: "/api/v1/github-sync",
          headers,
          payload: {},
        });
        expect(second.json()).toMatchObject({ staged: 0, alreadyStaged: 1 });
      } finally {
        clock.mockRestore();
      }
      expect(await stage(subject, f.path, f.content)).toMatchObject({
        staged: 0,
        alreadyStaged: 1,
      });
      expect(await db.note.count({ where: { ownerSubject: subject } })).toBe(0);
      expect(
        (
          await app.inject({
            url: "/api/v1/github-sync/status",
            headers: { cookie },
          })
        ).json(),
      ).toMatchObject({ pending: 1, processed: 0 });
      expect(source.calls.every((c) => c === "GET")).toBe(true);
    } finally {
      network.mockRestore();
      await app.close();
    }
  });

  it("imports and prepares under the restricted consumer grants, without original-update or auth access", async () => {
    const subject = owner(),
      f = note();
    await stage(subject, f.path, f.content);
    const role = "pce_staging_" + randomUUID().slice(0, 8);
    await db.$executeRawUnsafe(
      `CREATE ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN PASSWORD 'synthetic_staging_only'`,
    );
    const consumerUrl = new URL(url!);
    consumerUrl.username = role;
    consumerUrl.password = "synthetic_staging_only";
    const consumer = new PrismaClient({
      datasources: { db: { url: consumerUrl.toString() } },
    });
    try {
      await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await db.$executeRawUnsafe(`GRANT SELECT ON notes TO "${role}"`);
      await db.$executeRawUnsafe(`GRANT UPDATE (id) ON notes TO "${role}"`);
      await db.$executeRawUnsafe(
        `GRANT SELECT, UPDATE ON db_processing_jobs TO "${role}"`,
      );
      await db.$executeRawUnsafe(
        `GRANT SELECT, INSERT, DELETE ON note_chunks TO "${role}"`,
      );
      await db.$executeRawUnsafe(
        `GRANT SELECT, INSERT ON chunk_embeddings TO "${role}"`,
      );
      const grants = readFileSync(
        new URL("../../../deploy/gcp/staging-grants.sql", import.meta.url),
        "utf8",
      )
        .replaceAll(':"worker_role"', `"${role}"`)
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n");
      for (const command of grants
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s && s !== "BEGIN" && s !== "COMMIT"))
        await db.$executeRawUnsafe(command);
      expect(await processStagingPass(consumer, subject)).toMatchObject({
        processed: 1,
      });
      expect(await runDbJobPass(consumer, subject)).toMatchObject({
        prepared: 1,
      });
      await expect(
        consumer.note.update({
          where: { id: f.id },
          data: { body: "forbidden" },
        }),
      ).rejects.toThrow();
      await expect(consumer.authSession.count()).rejects.toThrow();
      await expect(
        consumer.ingestionStaging.updateMany({
          data: { rawContent: Buffer.from("forbidden") },
        }),
      ).rejects.toThrow();
    } finally {
      await consumer.$disconnect();
      await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await db.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  });

  it("authenticates manual sync, isolates owner, enforces CSRF, body bounds and disabled gates", async () => {
    const subject = owner();
    const authConfig = {
      mode: "dev-single-user" as const,
      ownerSubject: subject,
      origin: "http://127.0.0.1:4310",
      issuer: "http://127.0.0.1:3110",
      audience: "pce",
      secure: false,
    };
    const service = createGitHubSyncService(db, subject, null);
    const app = createApp({
      config: {
        host: "127.0.0.1",
        port: 3110,
        environment: "test",
        corsOrigin: authConfig.origin,
        requiresDatabase: false,
        auth: null,
      },
      dependencies: {
        sessionAuth: createSessionAuth(db, authConfig),
        githubSync: service,
      },
    });
    try {
      expect(
        (await app.inject({ url: "/api/v1/github-sync/status" })).statusCode,
      ).toBe(401);
      const login = await app.inject({
        method: "POST",
        url: "/auth/dev-session",
        headers: { origin: authConfig.origin },
        payload: {},
      });
      const cookie = login.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const csrf = login.cookies.find((c) => c.name === "pce_csrf")!.value;
      const headers = { cookie, origin: authConfig.origin, "x-pce-csrf": csrf };
      expect(
        (
          await app.inject({
            url: "/api/v1/github-sync/status",
            headers: { cookie },
          })
        ).json(),
      ).toMatchObject({ enabled: false, pending: 0 });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/github-sync",
            headers: { cookie },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/github-sync",
            headers,
            payload: { ownerSubject: "foreign" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/github-sync",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(503);
      service.allowedOwner = "foreign";
      expect(
        (
          await app.inject({
            url: "/api/v1/github-sync/status",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});

it("disabled fetching never requires credentials; unsafe transition configuration fails closed", () => {
  expect(githubFetchConfig({})).toBeNull();
  expect(
    githubFetchConfig({
      PCE_GITHUB_FETCH_ENABLED: "false",
      CONTENT_GITHUB_TOKEN: "",
    }),
  ).toBeNull();
  expect(() =>
    githubFetchConfig({ PCE_GITHUB_FETCH_ENABLED: "yes" }),
  ).toThrow();
  expect(() =>
    githubFetchConfig({
      PCE_GITHUB_FETCH_ENABLED: "true",
      PCE_INGEST_GITHUB: "true",
    }),
  ).toThrow();
});
