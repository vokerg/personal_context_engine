/**
 * Read a newline-separated list of changed repository paths.
 * Print a GitHub Actions output variable. A failed read fails the workflow.
 */
import { readFileSync } from "node:fs";
import { affectedServices } from "./change-scope.mjs";

const filename = process.argv[2];
if (!filename) {
  console.error(
    "Usage: node scripts/deploy/report-worker-changes.mjs CHANGED_PATHS_FILE",
  );
  process.exit(2);
}
const files = readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean);
console.log(
  "backend=" + (files.length === 0 || affectedServices(files).backend),
);
