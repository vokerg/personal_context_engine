/**
 * Vercel Ignored Build Step. Exit 0 skips, exit 1 builds.
 * Use the last *successful* deployment SHA to include all intervening merges.
 * If Vercel's shallow clone lacks that SHA, build rather than risk stale UI.
 */
import { execFileSync } from "node:child_process";
import { affectedServices } from "./deploy/change-scope.mjs";

if (process.env.VERCEL_GIT_COMMIT_REF !== "main") process.exit(0);

const previous = process.env.VERCEL_GIT_PREVIOUS_SHA?.trim();
const head = process.env.VERCEL_GIT_COMMIT_SHA?.trim() || "HEAD";
if (
  !/^[0-9a-f]{40}$/.test(previous ?? "") ||
  !/^(HEAD|[0-9a-f]{40})$/.test(head)
) {
  console.log("No valid previous/current Vercel SHA: build frontend safely.");
  process.exit(1);
}

try {
  // --no-renames keeps *both* paths when moving a file across deploy scopes.
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", previous, head, "--"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const build = affectedServices(changed).frontend;
  console.log(
    build
      ? "Frontend-affecting files changed: build."
      : "No frontend changes: skip build.",
  );
  process.exit(build ? 1 : 0);
} catch (error) {
  console.error(
    "Cannot compare Vercel revisions: build frontend safely.",
    error.message,
  );
  process.exit(1);
}
