/** Synthetic-only PostgreSQL recovery gate (#64, parent #61).
 * Explicit disposable DB targets only; no private repo or external API.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  chmod,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { createNoteRepository } from "@pce/db";
import { FilesystemContentStore } from "../apps/worker/dist/content-store/filesystem.js";
import { runIngestionBatch } from "../apps/worker/dist/worker.js";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
// Deliberate allowlist: never inherit DATABASE_URL, PG*, provider keys or NODE_OPTIONS.
const env = Object.fromEntries(
  ["PATH", "LANG", "LC_ALL", "SYSTEMROOT"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
const binary = (name) =>
  process.env.PCE_PG_BIN_DIR ? join(process.env.PCE_PG_BIN_DIR, name) : name;
const started = performance.now();
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => abort.abort());
}
let root;
let running = false;
let source;
let restored;
let phase = "prerequisites";
let failure;
let cleanupFailed = false;
let report;

async function command(name, args, extra = {}) {
  return exec(binary(name), args, {
    cwd: root ?? tmpdir(),
    env,
    timeout: 60_000,
    signal: abort.signal,
    maxBuffer: 1024 * 1024,
    ...extra,
  });
}

function fixture() {
  const noteId = randomUUID();
  const captureId = randomUUID();
  return {
    noteId,
    path: `inbox/2026-10-15_${noteId}.md`,
    markdown: `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: 2026-10-15T08:30:00+02:00
source: import
kind: idea
domains: ["development"]
projects: []
tags: ["synthetic"]
action_hint: none
review_required: false
title: Synthetic recovery fixture
timezone: Europe/Copenhagen
---

# Synthetic recovery fixture

## Summary

Synthetic summary.

## Original input

Synthetic original — æøå 日本語 🧪
Second line.
`,
  };
}

async function snapshot(db) {
  return {
    captures: await db.capture.findMany({ orderBy: { id: "asc" } }),
    notes: await db.note.findMany({ orderBy: { id: "asc" } }),
    attempts: await db.processingAttempt.findMany({ orderBy: { id: "asc" } }),
    migrations:
      await db.$queryRaw`SELECT * FROM _prisma_migrations ORDER BY id`,
  };
}

try {
  if (process.argv.length !== 2) throw new Error("No arguments accepted");
  for (const name of [
    "initdb",
    "pg_ctl",
    "createdb",
    "pg_dump",
    "pg_restore",
  ]) {
    const version = await command(name, ["--version"]);
    assert.match(version.stdout, /\(PostgreSQL\) 16\./);
  }
  phase = "isolated-cluster";
  root = await mkdtemp("/tmp/pce-recovery-synthetic-");
  await chmod(root, 0o700);
  // No TCP listener: even a port collision cannot redirect us to another DB.
  const socket = join(root, "socket");
  await mkdir(socket, { mode: 0o700 });
  // PostgreSQL's Unix socket path has a small platform limit; keep it short.
  assert.ok(Buffer.byteLength(join(socket, ".s.PGSQL.5432")) < 104);
  await command("initdb", [
    "-D",
    join(root, "data"),
    "-U",
    "pce_drill",
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  running = true; // Also inspect/stop a server if startup is interrupted.
  await command("pg_ctl", [
    "-D",
    join(root, "data"),
    "-l",
    join(root, "postgres.log"),
    "-o",
    `-h '' -k ${socket}`,
    "-w",
    "start",
  ]);
  const connection = ["-h", socket, "-U", "pce_drill"];
  for (const name of ["pce_source", "pce_restored"]) {
    await command("createdb", [...connection, name]);
  }
  const url = (name) =>
    `postgresql://pce_drill@localhost/${name}?host=${encodeURIComponent(socket)}`;
  phase = "migration";
  // Run Prisma in a disposable schema directory: its dotenv discovery cannot
  // inspect the application .env, even when launched from a configured checkout.
  await mkdir(join(root, "prisma"));
  await cp(
    join(repo, "packages/db/prisma/schema.prisma"),
    join(root, "prisma/schema.prisma"),
  );
  await cp(
    join(repo, "packages/db/prisma/migrations"),
    join(root, "prisma/migrations"),
    { recursive: true },
  );
  await exec(
    process.execPath,
    [
      join(repo, "node_modules/prisma/build/index.js"),
      "migrate",
      "deploy",
      "--schema",
      join(root, "prisma/schema.prisma"),
    ],
    {
      cwd: root,
      env: { ...env, DATABASE_URL: url("pce_source") },
      timeout: 60_000,
      signal: abort.signal,
      maxBuffer: 1024 * 1024,
    },
  );
  source = new PrismaClient({
    datasources: { db: { url: url("pce_source") } },
  });
  restored = new PrismaClient({
    datasources: { db: { url: url("pce_restored") } },
  });
  const storeRoot = join(root, "content");
  await mkdir(join(storeRoot, "inbox"), { recursive: true });
  const store = new FilesystemContentStore(storeRoot);
  const persisted = fixture();
  const retry = fixture();
  const discoveredLater = fixture();
  const foreign = fixture();
  const dbOnly = fixture();
  for (const item of [persisted, retry]) {
    await writeFile(join(storeRoot, item.path), item.markdown);
  }
  const input = await store.read(persisted.path);
  const importer = createNoteRepository(source);
  await importer.importMarkdown({
    markdown: input.content,
    sourcePath: input.path,
    sourceRevision: input.revision,
    ownerSubject: "synthetic-a",
  });
  await source.processingAttempt.create({
    data: {
      sourcePath: input.path,
      sourceRevision: input.revision,
      noteId: persisted.noteId,
      status: "PERSISTED",
      attemptCount: 1,
      leaseOwner: "interrupted-worker",
      leaseUntil: new Date("2026-10-15T10:00:00Z"),
      committedAt: new Date("2026-10-15T09:00:00Z"),
    },
  });
  const retryInput = await store.read(retry.path);
  await source.processingAttempt.create({
    data: {
      sourcePath: retryInput.path,
      sourceRevision: retryInput.revision,
      status: "RETRY",
      attemptCount: 1,
      nextRetryAt: new Date("2026-10-15T10:00:00Z"),
      lastErrorCode: "TRANSIENT_FAILURE",
    },
  });
  for (const [item, ownerSubject] of [
    [foreign, "synthetic-b"],
    [dbOnly, "synthetic-a"],
  ]) {
    await importer.importMarkdown({
      markdown: item.markdown,
      sourcePath: item.path,
      sourceRevision: "synthetic-db-only-revision",
      ownerSubject,
    });
  }
  phase = "dump-and-restore";
  const before = await snapshot(source);
  // Fail closed when schema expands: new tables need fixtures and assertions.
  const tables =
    await source.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  assert.deepEqual(
    tables.map((v) => v.tablename),
    ["_prisma_migrations", "captures", "notes", "processing_attempts"],
  );
  const archive = join(root, "synthetic.dump");
  await writeFile(archive, "", { mode: 0o600, flag: "wx" });
  const restoreStarted = performance.now();
  await command("pg_dump", [
    ...connection,
    "-Fc",
    "--no-owner",
    "--no-acl",
    "-f",
    archive,
    "pce_source",
  ]);
  await command("pg_restore", [
    ...connection,
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "--no-acl",
    "-d",
    "pce_restored",
    archive,
  ]);
  assert.deepEqual(await snapshot(restored), before);
  const restoreMs = Math.round(performance.now() - restoreStarted);
  phase = "ingestion-recovery";
  await writeFile(
    join(storeRoot, discoveredLater.path),
    discoveredLater.markdown,
  );
  const foreignBefore = await restored.note.findUniqueOrThrow({
    where: { id: foreign.noteId },
  });
  const dbOnlyBefore = await restored.note.findUniqueOrThrow({
    where: { id: dbOnly.noteId },
  });
  const restoredImporter = createNoteRepository(restored);
  const options = {
    db: restored,
    store,
    ownerSubject: "synthetic-a",
    now: () => new Date("2026-10-16T10:00:00Z"),
    importMarkdown: (item) =>
      restoredImporter.importMarkdown({ ...item, ownerSubject: "synthetic-a" }),
  };
  const first = await runIngestionBatch(options);
  assert.equal(first.reconciled, 1);
  assert.equal(first.imported, 2);
  assert.equal(first.finalized, 3);
  assert.equal(first.retried + first.rejected, 0);
  // Replay the same revision through the importer and worker independently.
  assert.equal(
    (
      await restoredImporter.importMarkdown({
        markdown: input.content,
        sourcePath: input.path,
        sourceRevision: input.revision,
        ownerSubject: "synthetic-a",
      })
    ).result,
    "replayed",
  );
  const second = await runIngestionBatch(options);
  assert.equal(
    second.imported +
      second.finalized +
      second.reconciled +
      second.retried +
      second.rejected,
    0,
  );
  assert.equal(await restored.note.count(), 5);
  assert.equal(await restored.capture.count(), 5);
  assert.equal(
    await restored.processingAttempt.count({ where: { status: "FINALIZED" } }),
    3,
  );
  assert.deepEqual(
    await restored.note.findUniqueOrThrow({ where: { id: foreign.noteId } }),
    foreignBefore,
  );
  assert.deepEqual(
    await restored.note.findUniqueOrThrow({ where: { id: dbOnly.noteId } }),
    dbOnlyBefore,
  );
  await assert.rejects(
    restoredImporter.importMarkdown({
      markdown: foreign.markdown,
      sourcePath: foreign.path,
      sourceRevision: "synthetic-db-only-revision",
      ownerSubject: "synthetic-a",
    }),
    { code: "OWNER_CONFLICT" },
  );
  for (const item of [persisted, retry, discoveredLater]) {
    const note = await restored.note.findUniqueOrThrow({
      where: { id: item.noteId },
    });
    assert.equal(note.ownerSubject, "synthetic-a");
    assert.equal(note.state, "FINALIZED");
    assert.equal(
      await readFile(join(storeRoot, note.canonicalPath), "utf8"),
      item.markdown,
    );
  }
  report = {
    status: "passed",
    syntheticOnly: true,
    restoredTables: 4,
    recoveredIngestions: 3,
    dbOnlyPreserved: true,
    ownerConflictRejected: true,
    dumpRestoreAndCompareMs: restoreMs,
  };
} catch {
  // No child stderr, SQL, content, local paths or inherited configuration.
  failure = phase;
} finally {
  for (const client of [source, restored]) {
    try {
      await client?.$disconnect();
    } catch {
      failure ??= "disconnect";
    }
  }
  if (root) {
    try {
      if (running) {
        let active = false;
        try {
          await command("pg_ctl", ["-D", join(root, "data"), "status"], {
            signal: undefined,
          });
          active = true;
        } catch (error) {
          if (error.code !== 3) throw error;
        }
        if (active)
          await command(
            "pg_ctl",
            ["-D", join(root, "data"), "-m", "immediate", "-w", "stop"],
            { signal: undefined },
          );
      }
      await rm(root, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
      failure ??= "cleanup";
    }
  }
}
if (abort.signal.aborted) failure ??= "interrupted";
if (failure) {
  console.error(
    `Synthetic recovery drill failed during ${failure}. No production database was targeted. Check PostgreSQL 16 binaries and prerequisites in docs/15-database-recovery.md.${cleanupFailed ? " Cleanup failed; inspect synthetic temporary directories as described in the runbook." : ""}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      ...report,
      totalMs: Math.round(performance.now() - started),
      cleanedUp: true,
    }),
  );
}
