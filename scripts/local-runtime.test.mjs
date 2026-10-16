import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localConfig,
  sessionAllowed,
  mintSession,
  createLocalReader,
  readCaptures,
} from "./local-runtime.mjs";

test("local startup rejects production, network binding, missing DB and conflicting ports", () => {
  for (const env of [
    {},
    { NODE_ENV: "production", DATABASE_URL: "fake" },
    { API_HOST: "0.0.0.0", DATABASE_URL: "fake" },
    { API_PORT: "3110", PCE_WEB_PORT: "3110", DATABASE_URL: "fake" },
  ])
    assert.throws(() => localConfig(env));
  assert.equal(localConfig({ DATABASE_URL: "fake" }).apiPort, 3110);
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

test("reader scopes SQL by owner and current checkout IDs", async () => {
  const calls = [];
  const db = {
    note: {
      findMany: async (query) => {
        calls.push(query);
        return [];
      },
      findFirst: async (query) => {
        calls.push(query);
        return null;
      },
    },
  };
  const reader = createLocalReader(db, ["known"]);
  assert.deepEqual(await reader.listByOwner("other"), []);
  assert.equal(await reader.getByOwner("local-developer", "unknown"), null);
  assert.equal(calls.length, 0);
  await reader.listByOwner("local-developer");
  await reader.getByOwner("local-developer", "known");
  assert.deepEqual(calls[0].where, {
    ownerSubject: "local-developer",
    id: { in: ["known"] },
  });
  assert.deepEqual(calls[1].where, {
    ownerSubject: "local-developer",
    id: "known",
  });
});

test("capture discovery rejects symlinks without following private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pce-local-test-"));
  try {
    await mkdir(join(root, "inbox"));
    await writeFile(join(root, "outside.md"), "synthetic");
    await symlink(join(root, "outside.md"), join(root, "inbox", "note.md"));
    await assert.rejects(readCaptures(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture snapshot validates notes, skips invalid input and replays stable revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pce-local-test-"));
  const id = "01K00000000000000000000001";
  const { serializeNoteMarkdown } = await import("@pce/core");
  const summary = "Synthetic summary.";
  const originalInput = "Synthetic input.\n";
  const markdown = serializeNoteMarkdown({
    metadata: {
      schema_version: 1,
      id,
      capture_id: "01K00000000000000000000000",
      captured_at: "2026-10-16T10:00:00Z",
      source: "import",
      kind: "memo",
      domains: [],
      projects: [],
      tags: [],
      action_hint: "none",
      review_required: false,
      title: "Synthetic note",
    },
    summary,
    originalInput,
    body: `\n# Synthetic note\n\n## Summary\n\n${summary}\n\n## Original input\n\n${originalInput}`,
  });
  try {
    await mkdir(join(root, "inbox"));
    const file = join(root, "inbox", `2026-10-16_${id}.md`);
    await writeFile(file, markdown);
    await writeFile(
      join(root, "inbox", "invalid.md"),
      "invalid synthetic note",
    );
    const first = await readCaptures(root);
    const replay = await readCaptures(root);
    assert.equal(first.captures.length, 1);
    assert.equal(first.rejectedCount, 1);
    assert.equal(first.captures[0].ownerSubject, "local-developer");
    assert.equal(
      first.captures[0].sourceRevision,
      replay.captures[0].sourceRevision,
    );
    assert.equal(
      await (await import("node:fs/promises")).readFile(file, "utf8"),
      markdown,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local API refuses missing/forged tokens and serves only the verified owner's records", async () => {
  const { createApp } = await import("../apps/api/dist/app.js");
  const secret = "a".repeat(64);
  const app = createApp({
    config: {
      host: "127.0.0.1",
      port: 3110,
      environment: "development",
      corsOrigin: null,
      requiresDatabase: false,
      auth: { issuer: "pce-local-development", audience: "pce-api", secret },
    },
    dependencies: {
      notes: createLocalReader(
        {
          note: {
            findMany: async ({ where }) => {
              assert.equal(where.ownerSubject, "local-developer");
              return [];
            },
          },
        },
        [],
      ),
    },
  });
  try {
    assert.equal((await app.inject({ url: "/api/v1/notes" })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/notes",
          headers: { authorization: "Bearer invalid" },
        })
      ).statusCode,
      401,
    );
    const response = await app.inject({
      url: "/api/v1/notes",
      headers: { authorization: "Bearer " + mintSession(secret) },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { notes: [] });
  } finally {
    await app.close();
  }
});

test("Git snapshots use original blob bytes instead of checkout line endings", async () => {
  const { execFileSync } = await import("node:child_process");
  const { serializeNoteMarkdown } = await import("@pce/core");
  const root = await mkdtemp(join(tmpdir(), "pce-git-snapshot-"));
  const id = "01K00000000000000000000001";
  const body =
    "\n# Synthetic note\n\n## Summary\n\nSynthetic summary.\n\n## Original input\n\nSynthetic input.\n";
  const markdown = serializeNoteMarkdown({
    metadata: {
      schema_version: 1,
      id,
      capture_id: "01K00000000000000000000000",
      captured_at: "2026-10-16T10:00:00Z",
      source: "import",
      kind: "memo",
      domains: [],
      projects: [],
      tags: [],
      action_hint: "none",
      review_required: false,
      title: "Synthetic note",
    },
    body,
    summary: "Synthetic summary.",
    originalInput: "Synthetic input.\n",
  });
  try {
    await mkdir(join(root, "inbox"));
    const path = `inbox/2026-10-16_${id}.md`;
    await writeFile(join(root, path), markdown);
    const git = (...args) =>
      execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init");
    git("config", "core.autocrlf", "false");
    git("add", path);
    git(
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-m",
      "Synthetic capture",
    );
    await writeFile(join(root, path), markdown.replaceAll("\n", "\r\n"));
    const snapshot = await readCaptures(root, { gitSnapshot: true });
    assert.equal(snapshot.captures[0].markdown, markdown);
    const hash = git("rev-parse", `HEAD:${path}`).toString().trim();
    assert.equal(snapshot.captures[0].sourceRevision, hash);
    await writeFile(join(root, path), markdown + "changed");
    await assert.rejects(readCaptures(root, { gitSnapshot: true }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!process.env.PCE_DB_TEST_URL)(
  "worker bridges only verified preview line endings, finalizes and replays without duplicate rows",
  async () => {
    const { randomUUID, createHash } = await import("node:crypto");
    const { execFileSync } = await import("node:child_process");
    const { createNoteRepository, PrismaClient } = await import("@pce/db");
    const { createOwnedImporter } = await import("./local-runtime.mjs");
    const { runIngestionBatch } = await import("../apps/worker/dist/worker.js");
    const { serializeNoteMarkdown } = await import("@pce/core");
    const db = new PrismaClient({
      datasources: { db: { url: process.env.PCE_DB_TEST_URL } },
    });
    const root = await mkdtemp(join(tmpdir(), "pce-worker-bridge-"));
    const id = randomUUID(),
      captureId = randomUUID();
    const path = `inbox/2026-10-16_${id}.md`;
    const markdown = serializeNoteMarkdown({
      metadata: {
        schema_version: 1,
        id,
        capture_id: captureId,
        captured_at: "2026-10-16T10:00:00Z",
        source: "import",
        kind: "memo",
        domains: [],
        projects: [],
        tags: [],
        action_hint: "none",
        review_required: false,
        title: "Synthetic note",
      },
      body: "\n# Synthetic note\n\n## Summary\n\nSynthetic summary.\n\n## Original input\n\nSynthetic input.\n",
      summary: "Synthetic summary.",
      originalInput: "Synthetic input.\n",
    });
    try {
      await mkdir(join(root, "inbox"));
      await writeFile(join(root, path), markdown);
      const git = (...args) =>
        execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
      git("init");
      git("config", "core.autocrlf", "false");
      git("add", path);
      git(
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "-m",
        "Synthetic capture",
      );
      const revision = git("rev-parse", `HEAD:${path}`).toString().trim();
      const crlf = markdown.replaceAll("\n", "\r\n");
      await writeFile(join(root, path), crlf);
      await createNoteRepository(db).importMarkdown({
        markdown: crlf,
        sourcePath: path,
        sourceRevision: createHash("sha256").update(crlf).digest("hex"),
        ownerSubject: "local-developer",
      });
      const project = createOwnedImporter(db, { checkoutRoot: root });
      await assert.rejects(
        project({
          markdown: markdown.replace("Synthetic summary.", "Changed summary."),
          sourcePath: path,
          sourceRevision: "changed",
        }),
      );
      let pending = true,
        moved = false;
      const store = {
        async listPending() {
          return { files: pending ? [{ path, revision }] : [] };
        },
        async read() {
          return { path, revision, content: markdown };
        },
        async stat(target) {
          return target === path
            ? pending
              ? { path, revision }
              : null
            : moved
              ? { path: target, revision }
              : null;
        },
        async finalize(request) {
          assert.equal(request.expectedRevision, revision);
          assert.equal(
            await db.note.count({
              where: { id, ownerSubject: "local-developer" },
            }),
            1,
          );
          pending = false;
          moved = true;
          return { path: request.destinationPath, revision, status: "moved" };
        },
        async reject() {
          throw new Error("Unexpected rejection");
        },
      };
      const report = await runIngestionBatch({
        db,
        store,
        ownerSubject: "local-developer",
        importMarkdown: project,
      });
      assert.equal(report.finalized, 1);
      assert.equal(report.rejected, 0);
      assert.equal(await db.note.count({ where: { id } }), 1);
      const note = await db.note.findUnique({ where: { id } });
      assert.equal(note.state, "FINALIZED");
      assert.equal(note.sourceRevision, revision);
      assert.equal(note.originalInput, "Synthetic input.\n");
      const replay = await project({
        markdown,
        sourcePath: path,
        sourceRevision: revision,
      });
      assert.equal(replay.result, "replayed");
      assert.equal(
        (await db.note.findUnique({ where: { id } })).state,
        "FINALIZED",
      );
      const second = await runIngestionBatch({
        db,
        store,
        ownerSubject: "local-developer",
        importMarkdown: project,
      });
      assert.equal(second.finalized, 0);
    } finally {
      await db.processingAttempt.deleteMany({ where: { sourcePath: path } });
      await db.note.deleteMany({ where: { id } });
      await db.capture.deleteMany({ where: { id: captureId } });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  },
);
