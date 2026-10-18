import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  createOwnedImporter,
  readCaptures,
  subject,
} from "./local-runtime.mjs";
const exec = promisify(execFile);

export function startLocalIngestion({
  db,
  contentRoot,
  ids,
  env,
  intervalMs = 30000,
}) {
  const enabled = env.PCE_INGEST_GITHUB === "true";
  const status = {
    enabled,
    running: false,
    lastRun: null,
    report: null,
    error: null,
    checkpoint: null,
    reconciliation: null,
  };
  let timer;
  let pending;
  let stopped = false;
  const project = createOwnedImporter(db, { checkoutRoot: contentRoot });
  async function git(...args) {
    return (
      await exec("git", ["-C", contentRoot, ...args], {
        maxBuffer: 1024 * 1024,
        timeout: 30000,
      })
    ).stdout.trim();
  }
  async function run() {
    status.running = true;
    let checkpointKey;
    let checkpoint;
    try {
      let store;
      if (enabled) {
        const repository = env.CONTENT_REPOSITORY;
        const branch = env.CONTENT_BRANCH ?? "main";
        if (
          !repository ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
        )
          throw new Error("Repository required");
        const remote = await git("remote", "get-url", "origin");
        const expected = [
          "https://github.com/" + repository,
          "git@github.com:" + repository,
        ];
        if (
          !expected.some(
            (value) => remote === value || remote === value + ".git",
          )
        )
          throw new Error("Checkout mismatch");
        if (await git("status", "--porcelain"))
          throw new Error("Content checkout is dirty");
        if ((await git("branch", "--show-current")) !== branch)
          throw new Error("Branch mismatch");
        const token =
          env.CONTENT_GITHUB_TOKEN ||
          (
            await exec("gh", ["auth", "token"], { timeout: 15000 })
          ).stdout.trim();
        const response = await fetch(
          `https://api.github.com/repos/${repository}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok || (await response.json()).private !== true)
          throw new Error("Private repository required");
        await git("pull", "--ff-only");
        checkpointKey = createHash("sha256")
          .update(
            JSON.stringify([
              "github",
              repository.toLowerCase(),
              branch,
              subject,
            ]),
          )
          .digest("hex");
        checkpoint = await db.ingestionCheckpoint.upsert({
          where: { key: checkpointKey },
          create: {
            key: checkpointKey,
            observedRevision: await git("rev-parse", "HEAD"),
          },
          update: {
            observedRevision: await git("rev-parse", "HEAD"),
            reconciliationPending: true,
          },
        });
        status.checkpoint = checkpointStatus(checkpoint);
        const { GitHubContentStore } =
          await import("../apps/worker/dist/content-store/github.js");
        const { runIngestionBatch } =
          await import("../apps/worker/dist/worker.js");
        store = new GitHubContentStore({
          repository,
          branch,
          token,
          fetch: (input, init) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
        });
        status.report = await runIngestionBatch({
          db,
          store,
          ownerSubject: subject,
          importMarkdown: project,
          scanCheckpointKey: checkpointKey,
        });
        await git("pull", "--ff-only");
      }
      const snapshotHead = enabled ? await git("rev-parse", "HEAD") : null;
      const snapshot = await readCaptures(contentRoot, {
        gitSnapshot: enabled,
      });
      const reconciled = await reconcileSnapshot({
        snapshot,
        project,
        knownNoteIds: checkpoint?.knownNoteIds ?? [],
      });
      if (checkpointKey) {
        const head = await git("rev-parse", "HEAD");
        // Check that no local editor changed the snapshot during import.
        if (head !== snapshotHead || (await git("status", "--porcelain")))
          throw new Error("Checkout changed");
        const complete =
          reconciled.conflicts === 0 &&
          reconciled.missing === 0 &&
          snapshot.rejectedCount === 0 &&
          !status.report.retried &&
          !status.report.rejected &&
          !status.report.deferred;
        checkpoint = await db.ingestionCheckpoint.update({
          where: { key: checkpointKey },
          data: {
            observedRevision: head,
            knownNoteIds: reconciled.knownNoteIds,
            reconciliationPending: !complete,
            ...(complete
              ? { reconciledRevision: head, reconciledAt: new Date() }
              : {}),
          },
        });
        status.checkpoint = checkpointStatus(checkpoint);
      }
      status.reconciliation = {
        conflicts: reconciled.conflicts,
        missing: reconciled.missing,
        invalid: snapshot.rejectedCount,
      };
      ids.splice(0, ids.length, ...reconciled.ids);
      status.error = null;
      status.lastRun = new Date().toISOString();
      console.log(
        "Local ingestion " +
          JSON.stringify({
            enabled,
            notes: ids.length,
            skipped: snapshot.rejectedCount,
            report: status.report,
          }),
      );
    } catch {
      status.error =
        "INGESTION_FAILED_CHECK_PRIVATE_REPO_AUTH_CLEAN_CHECKOUT_AND_OWNERSHIP";
      console.error(
        "Local ingestion failed; previous readable snapshot retained. Check repository access, clean checkout and source ownership.",
      );
    } finally {
      status.running = false;
    }
  }
  function refresh() {
    if (stopped) return Promise.resolve();
    if (!pending)
      pending = run().finally(() => {
        pending = undefined;
      });
    return pending;
  }
  return {
    status,
    refresh,
    start() {
      if (enabled)
        timer = setInterval(() => {
          void refresh();
        }, intervalMs);
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}

// HTTP status intentionally excludes repository identifiers, note IDs and cursors.
function checkpointStatus(row) {
  return {
    lastScanAt: row.lastScanAt?.toISOString() ?? null,
    reconciledAt: row.reconciledAt?.toISOString() ?? null,
    revisionPending:
      row.reconciliationPending ||
      row.observedRevision !== row.reconciledRevision,
  };
}

export async function reconcileSnapshot({ snapshot, project, knownNoteIds }) {
  const { ProjectionConflictError } = await import("@pce/db");
  const { parseNoteMarkdown } = await import("@pce/core");
  const observed = new Set(
    snapshot.captures.map((c) => parseNoteMarkdown(c.markdown).metadata.id),
  );
  const ids = [];
  let conflicts = 0;
  for (const capture of snapshot.captures) {
    try {
      ids.push((await project(capture)).noteId);
    } catch (error) {
      if (!(error instanceof ProjectionConflictError)) throw error;
      // A changed revision/identity needs deliberate repair. Keep DB originals
      // and Git bytes intact, and continue to later independent captures.
      conflicts++;
    }
  }
  const known = new Set([...knownNoteIds, ...ids]);
  return {
    ids,
    conflicts,
    missing: [...known].filter((id) => !observed.has(id)).length,
    knownNoteIds: [...known].sort(),
  };
}
