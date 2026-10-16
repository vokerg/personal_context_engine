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
  };
  let timer;
  let pending;
  let stopped = false;
  const project = createOwnedImporter(db, { checkoutRoot: contentRoot });
  async function git(...args) {
    return (
      await exec("git", ["-C", contentRoot, ...args], {
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  }
  async function run() {
    status.running = true;
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
          (await exec("gh", ["auth", "token"])).stdout.trim();
        const response = await fetch(
          `https://api.github.com/repos/${repository}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok || (await response.json()).private !== true)
          throw new Error("Private repository required");
        await git("pull", "--ff-only");
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
        });
        await git("pull", "--ff-only");
      }
      const snapshot = await readCaptures(contentRoot, {
        gitSnapshot: enabled,
      });
      const nextIds = [];
      for (const capture of snapshot.captures)
        nextIds.push((await project(capture)).noteId);
      ids.splice(0, ids.length, ...nextIds);
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
