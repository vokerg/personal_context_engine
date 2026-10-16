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
