/**
 * Refuse deploying an obsolete backend, but allow a later frontend-only merge.
 * GitHub Actions checks out a trusted, merged SHA with full history.
 */
import { execFileSync } from "node:child_process";
import { affectedServices } from "./change-scope.mjs";

const release = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(release ?? "")) {
  console.error("Expected exact 40-character merged revision.");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
try {
  git("fetch", "--no-tags", "origin", "main");
  const main = git("rev-parse", "FETCH_HEAD");
  git("merge-base", "--is-ancestor", release, main);
  const paths = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", release, main, "--"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  if (affectedServices(paths).backend) {
    console.error(
      "A newer backend change reached main: refuse stale worker release.",
    );
    process.exit(1);
  }
  console.log(
    "Worker revision is current for backend files (later frontend changes allowed).",
  );
} catch (error) {
  console.error("Cannot verify worker release against main:", error.message);
  process.exit(1);
}
