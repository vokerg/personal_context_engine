// Run manually ON the intended acquisition host with server-side environment
// already supplied. No dotenv loading, repository mutation, or DB connection.
import { githubContentStoreFromEnv } from "@pce/db";
try {
  await githubContentStoreFromEnv().listArtifacts({ limit: 1 });
  console.log("GitHub HTTPS and configured private repository read verified on this host.");
} catch {
  console.error("GitHub preflight failed. Keep PCE_GITHUB_FETCH_ENABLED=false; check HTTPS egress, repository, branch and Contents:read credential privately.");
  process.exitCode = 1;
}
