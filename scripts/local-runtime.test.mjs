import { test } from "vitest";
import assert from "node:assert/strict";
import { localConfig, sessionAllowed, mintSession } from "./local-runtime.mjs";

test("local startup rejects production, network binding, missing DB and conflicting ports", () => {
  for (const env of [
    {},
    { NODE_ENV: "production", DATABASE_URL: "fake" },
    { API_HOST: "0.0.0.0", DATABASE_URL: "fake" },
    { API_PORT: "3110", PCE_WEB_PORT: "3110", DATABASE_URL: "fake" },
  ])
    assert.throws(() => localConfig(env));
  assert.equal(localConfig({ DATABASE_URL: "fake" }).apiPort, 3110);
  assert.deepEqual(localConfig({ DATABASE_URL: "fake" }).origins, [
    "http://127.0.0.1:4310",
    "http://localhost:4310",
  ]);
});

test("session issuance checks Host, Origin, fetch metadata, method and peer", () => {
  const origin = "http://127.0.0.1:4310";
  const request = {
    method: "GET",
    headers: {
      host: "127.0.0.1:4310",
      origin,
      "sec-fetch-site": "same-origin",
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(sessionAllowed(request, origin), true);
  assert.equal(
    sessionAllowed(
      {
        ...request,
        headers: {
          ...request.headers,
          host: "localhost:4310",
          origin: "http://localhost:4310",
        },
      },
      [origin, "http://localhost:4310"],
    ),
    true,
  );
  assert.equal(
    sessionAllowed(
      {
        ...request,
        headers: {
          ...request.headers,
          host: "localhost:4310",
        },
      },
      [origin, "http://localhost:4310"],
    ),
    false,
  );
  for (const headers of [
    { host: "evil.test:4310" },
    { origin: "http://evil.test" },
    { "sec-fetch-site": "cross-site" },
  ])
    assert.equal(
      sessionAllowed(
        { ...request, headers: { ...request.headers, ...headers } },
        origin,
      ),
      false,
    );
  assert.equal(sessionAllowed({ ...request, method: "POST" }, origin), false);
  assert.equal(
    sessionAllowed(
      { ...request, socket: { remoteAddress: "192.0.2.1" } },
      origin,
    ),
    false,
  );
});

test("ephemeral sessions pass the API verifier and expire", async () => {
  const { createHmacTokenVerifier } = await import("../apps/api/dist/auth.js");
  const secret = "a".repeat(64);
  const config = {
    issuer: "pce-local-development",
    audience: "pce-api",
    secret,
  };
  const token = mintSession(secret, 1000);
  assert.equal(
    (await createHmacTokenVerifier(config, () => 1001)(token)).subject,
    "local-developer",
  );
  assert.equal(await createHmacTokenVerifier(config, () => 1900)(token), null);
  assert.equal(
    await createHmacTokenVerifier(
      { ...config, secret: "b".repeat(64) },
      () => 1001,
    )(token),
    null,
  );
});

test.skipIf(!process.env.PCE_DB_TEST_URL)(
  "development startup serves new DB originals without acquiring or processing content",
  async () => {
    const { PrismaClient, createApiCaptureRepository } =
      await import("@pce/db");
    const { randomUUID } = await import("node:crypto");
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer } = await import("node:net");
    const { setTimeout: delay } = await import("node:timers/promises");
    const db = new PrismaClient({
      datasources: { db: { url: process.env.PCE_DB_TEST_URL } },
    });
    const owner = "dev-boundary-" + randomUUID();
    const id = randomUUID(),
      captureId = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), "pce-dev-boundary-"));
    const port = async () => {
      const server = createServer();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const value = server.address().port;
      await new Promise((resolve) => server.close(resolve));
      return value;
    };
    const apiPort = await port(),
      webPort = await port();
    let child, exited;
    try {
      const staged = await db.ingestionStaging.create({
        data: {
          ownerSubject: owner,
          provider: "github",
          artifactType: "note",
          repository: "synthetic-owner/missing-source",
          branch: "main",
          sourcePath: "inbox/synthetic.md",
          sourceRevision: "synthetic-revision",
          rawContent: Buffer.from("synthetic invalid input"),
          contentHash: "a".repeat(64),
        },
      });
      const preload = join(directory, "no-egress.mjs");
      await writeFile(
        preload,
        'globalThis.fetch = async () => { throw new Error("No network allowed in development startup test"); };\n',
      );
      child = spawn(process.execPath, ["scripts/local-dev.mjs"], {
        env: {
          ...process.env,
          DATABASE_URL: process.env.PCE_DB_TEST_URL,
          NODE_ENV: "development",
          NODE_OPTIONS: `--import=${preload}`,
          API_HOST: "127.0.0.1",
          API_PORT: String(apiPort),
          PCE_WEB_PORT: String(webPort),
          PCE_AUTH_MODE: "dev-single-user",
          PCE_OWNER_SUBJECT: owner,
          PCE_DB_SEARCH: "false",
          PCE_MCP_ENABLED: "false",
          PCE_OAUTH_CLIENTS: "[]",
          PCE_TASKS_ENABLED: "false",
          PCE_RESEARCH_REPORTS: "false",
          PCE_CONTENT_ROOT: join(directory, "does-not-exist"),
          PCE_GITHUB_FETCH_ENABLED: "true",
          PCE_INGEST_GITHUB: "false",
          WORKER_ALLOW_GITHUB_WRITES: "",
          CONTENT_REPOSITORY: "synthetic-owner/missing-source",
          CONTENT_BRANCH: "main",
          CONTENT_GITHUB_TOKEN: "synthetic-read-only-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      exited = once(child, "exit");
      for (
        let i = 0;
        i < 180 && !output.includes(`Open http://127.0.0.1:${webPort}`);
        i++
      ) {
        assert.equal(child.exitCode, null, output.slice(-2000));
        await delay(500);
      }
      assert.ok(
        output.includes(`Open http://127.0.0.1:${webPort}`),
        output.slice(-2000),
      );
      const session = await fetch(`http://127.0.0.1:${webPort}/__pce/session`);
      assert.equal(session.status, 200);
      const cookie = session.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const headers = { cookie };
      const endpoint = `http://127.0.0.1:${apiPort}/api/v1/notes/${id}`;
      assert.equal((await fetch(endpoint, { headers })).status, 404);
      const markdown = `---\nschema_version: 1\nid: ${id}\ncapture_id: ${captureId}\ncaptured_at: 2026-11-03T10:00:00Z\nsource: import\nkind: memo\ndomains: []\nprojects: []\ntags: []\naction_hint: none\nreview_required: false\ntitle: Synthetic development boundary\n---\n\n# Synthetic\n\n## Summary\n\nSynthetic.\n\n## Original input\n\nSynthetic original.\n`;
      await createApiCaptureRepository(db).persistByOwner(owner, {
        idempotencyKey: "dev-boundary",
        notes: [markdown],
      });
      const note = await fetch(endpoint, { headers });
      assert.equal(note.status, 200);
      assert.match((await note.json()).originalInput, /Synthetic original/);
      // Cross the former 30-second timer boundary with fetch capability enabled.
      await delay(31000);
      assert.equal(
        (await db.ingestionStaging.findUnique({ where: { id: staged.id } }))
          .status,
        "PENDING",
      );
      assert.equal(
        (await db.dbProcessingJob.findFirst({ where: { ownerSubject: owner } }))
          .status,
        "PENDING",
      );
      assert.equal(
        (await db.ingestionStaging.findUnique({ where: { id: staged.id } }))
          .attemptCount,
        0,
      );
    } finally {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      if (exited) await exited;
      await db.authSession.deleteMany({ where: { ownerSubject: owner } });
      await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
      await db.ingestionStaging.deleteMany({ where: { ownerSubject: owner } });
      await db.note.deleteMany({ where: { id } });
      await db.capture.deleteMany({ where: { id: captureId } });
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  180000,
);
