import { pathToFileURL } from "node:url";

const modes = new Set([
  "embeddings-once",
  "embeddings-loop",
  "db-jobs-once",
  "db-jobs-loop",
]);

// Keep the mode set by the npm command ahead of any WORKER_MODE in .env,
// matching the previous shell assignment on every supported platform.
export async function runWorker(
  mode,
  {
    env = process.env,
    loadEnvFile = () =>
      process.loadEnvFile(new URL("../.env", import.meta.url)),
    run = () => import("../apps/worker/dist/main.js"),
  } = {},
) {
  if (!modes.has(mode)) throw new Error("Invalid worker mode");
  env.WORKER_MODE = mode;
  loadEnvFile();
  env.WORKER_MODE = mode;
  await run();
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    if (process.argv.length !== 3) throw new Error("Invalid arguments");
    await runWorker(process.argv[2]);
  } catch {
    console.error(
      "Worker startup failed. Check the mode, root .env and workspace build.",
    );
    process.exitCode = 1;
  }
}
