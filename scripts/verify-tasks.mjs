import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Deliberately narrow: this command migrates only a named disposable local DB. */
export function validateTaskTestDatabase(value) {
  const fail = () => {
    throw new Error(
      "Set PCE_DB_TEST_URL to a disposable loopback pce_test or pce_tasks_* database",
    );
  };
  if (!value) fail();
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/(?:pce_test|pce_tasks_[A-Za-z0-9_]+)$/.test(url.pathname) ||
    url.hash
  )
    fail();
  const seen = new Set();
  for (const [key, entry] of url.searchParams) {
    if (seen.has(key) || !["schema", "host"].includes(key)) fail();
    seen.add(key);
    if (key === "schema" && entry !== "public") fail();
    // libpq-style host overrides must not turn a loopback URL into remote access.
    if (
      key === "host" &&
      (!/^\/(?:tmp|private\/tmp|var\/folders)\//.test(entry) ||
        entry.includes("..") ||
        entry.includes(",") ||
        entry.includes("\\") ||
        entry.includes("\0"))
    )
      fail();
  }
  return value;
}

export function taskVerificationEnvironment(env, databaseUrl) {
  const result = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "CI",
    "TERM",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ])
    if (env[key] !== undefined) result[key] = env[key];
  return {
    ...result,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    PCE_DB_TEST_URL: databaseUrl,
  };
}

async function verify() {
  const databaseUrl = validateTaskTestDatabase(process.env.PCE_DB_TEST_URL);
  for (const dir of [root, join(root, "apps/web"), join(root, "apps/mobile")]) {
    if (
      (await readdir(dir)).some(
        (name) => /^\.env(?:\.|$)/.test(name) && name !== ".env.example",
      )
    )
      throw new Error(
        "Use an isolated checkout without dotenv files for tasks:verify",
      );
  }
  const env = taskVerificationEnvironment(process.env, databaseUrl);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run with npm run tasks:verify");
  const passed = [];
  const run = async (label, args, cwd = root) => {
    process.stdout.write(`\nTask acceptance: ${label}\n`);
    await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env,
        stdio: "inherit",
      });
      child.once("error", () => no(new Error(`${label}: process unavailable`)));
      child.once("exit", (code) =>
        code === 0 ? yes() : no(new Error(`${label}: failed`)),
      );
    });
    passed.push(label);
  };
  const scratch = await mkdtemp(join(tmpdir(), "pce-task-acceptance-"));
  try {
    await run("build shared packages", [npmCli, "run", "dev:prepare"]);
    await run("build API", [npmCli, "run", "build", "-w", "@pce/api"]);
    await run("build worker", [npmCli, "run", "build", "-w", "@pce/worker"]);
    // Prisma runs outside the checkout to avoid implicit dotenv discovery.
    await cp(join(root, "packages/db/prisma"), join(scratch, "prisma"), {
      recursive: true,
    });
    const schema = join(scratch, "prisma/schema.prisma");
    const prisma = join(root, "node_modules/prisma/build/index.js");
    for (const label of ["migrations", "migration replay"])
      await run(
        label,
        [prisma, "migrate", "deploy", "--schema", schema],
        scratch,
      );
    await run(
      "schema drift",
      [
        prisma,
        "migrate",
        "diff",
        "--from-schema-datamodel",
        schema,
        "--to-schema-datasource",
        schema,
        "--exit-code",
      ],
      scratch,
    );
    await run("synthetic cross-surface suites", [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--no-file-parallelism",
      "scripts/verify-tasks.test.mjs",
      "packages/contracts/src/tasks.test.ts",
      "packages/contracts/src/task-extraction.test.ts",
      "packages/db/src/tasks.integration.test.ts",
      "packages/db/src/task-policy.integration.test.ts",
      "apps/api/src/tasks.integration.test.ts",
      "apps/api/src/task-acceptance.integration.test.ts",
      "apps/api/src/mcp.integration.test.ts",
      "apps/worker/src/task-ingress.integration.test.ts",
      "apps/worker/src/content-store/github.test.ts",
      "packages/api-client/src/tasks.test.ts",
      "apps/web/src/TasksPanel.test.tsx",
      "apps/mobile/task-requests.test.ts",
      "apps/mobile/task-screen.test.tsx",
      "apps/mobile/session.test.ts",
      "apps/mobile/tab-bar.test.tsx",
      "apps/mobile/navigation.test.ts",
    ]);
    process.stdout.write(
      `\nPassed ${passed.length} verification steps.\nManual gates NOT performed: native device/VoiceOver, live model, ChatGPT Project/plugin installation, hosted rollout or production consent. See docs/25-task-acceptance.md.\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  verify().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
