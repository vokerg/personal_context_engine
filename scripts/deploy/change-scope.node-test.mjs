import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { affectedServices } from "./change-scope.mjs";

const scope = (...files) => affectedServices(files);
test("frontend-only, backend-only and mixed changes", () => {
  assert.deepEqual(scope("apps/web/src/app/home.component.ts"), {
    frontend: true,
    backend: false,
  });
  assert.deepEqual(scope("vercel.json"), { frontend: true, backend: false });
  for (const path of [
    "apps/api/src/main.ts",
    "apps/worker/src/main.ts",
    "render.yaml",
    "deploy/gcp/package.sh",
    "scripts/deploy-migrate.mjs",
  ]) {
    assert.deepEqual(scope(path), { frontend: false, backend: true }, path);
  }
  assert.deepEqual(scope("apps/web/src/app/page.ts", "apps/api/src/main.ts"), {
    frontend: true,
    backend: true,
  });
});
test("global build inputs deploy both; documents, mobile and inactive hosts deploy neither", () => {
  for (const path of [
    "package.json",
    "package-lock.json",
    "package.json",
    "tsconfig.json",
    ".nvmrc",
    "scripts/deploy/change-scope.mjs",
    "packages/shared/src/home-summary.ts",
    "packages/db/src/schema.ts",
  ]) {
    assert.deepEqual(scope(path), { frontend: true, backend: true }, path);
  }
  for (const path of [
    "README.md",
    "AGENTS.md",
    "docs/DEPLOYMENT.md",
    "apps/mobile/package.json",
    ".agents/skills/ios-device-release/SKILL.md",
    ".github/workflows/docs.yml",
  ]) {
    assert.deepEqual(scope(path), { frontend: false, backend: false }, path);
  }
});
test("unknown paths fail open rather than skipping a necessary deploy", () => {
  assert.deepEqual(scope("scripts/new-build-tool.mjs"), {
    frontend: true,
    backend: true,
  });
  assert.deepEqual(scope("apps/new-app/src/index.ts"), {
    frontend: true,
    backend: true,
  });
  assert.deepEqual(scope("../outside"), { frontend: true, backend: true });
});

const vercelScript = resolve("scripts/vercel-ignore-build.mjs");
function withRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), "pce-deploy-test-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commit = (filename, contents) => {
    const target = join(dir, filename);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
    git("add", ".");
    git(
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-m",
      "test",
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    const first = commit("apps/web/page.ts", "one");
    run({ dir, git, commit, first });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("Vercel compares to last successful release across multiple commits", () => {
  withRepo(({ dir, first, commit }) => {
    commit("apps/api/src/main.ts", "two");
    const apiSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    const frontendSha = commit("apps/web/page.ts", "three");
    const invoke = (previous, head) =>
      spawnSync(process.execPath, [vercelScript], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          VERCEL_GIT_COMMIT_REF: "main",
          VERCEL_GIT_PREVIOUS_SHA: previous,
          VERCEL_GIT_COMMIT_SHA: head,
        },
      });
    assert.equal(
      invoke(first, apiSha).status,
      0,
      "backend-only skips frontend",
    );
    assert.equal(
      invoke(first, frontendSha).status,
      1,
      "intervening frontend change builds",
    );
    assert.equal(invoke(apiSha, frontendSha).status, 1);
    assert.equal(
      invoke("", frontendSha).status,
      1,
      "first Vercel deployment builds",
    );
    assert.equal(
      invoke("a".repeat(40), frontendSha).status,
      1,
      "missing history builds",
    );
  });
});
test("Vercel sees original path when a file moves out of frontend", () => {
  withRepo(({ dir, first, git }) => {
    mkdirSync(join(dir, "apps/api"), { recursive: true });
    git("mv", "apps/web/page.ts", "apps/api/page.ts");
    git(
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-m",
      "move",
    );
    const result = spawnSync(process.execPath, [vercelScript], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_PREVIOUS_SHA: first,
        VERCEL_GIT_COMMIT_SHA: git("rev-parse", "HEAD"),
      },
    });
    assert.equal(result.status, 1);
  });
});

test("Vercel rebuilds shared workspace source", () => {
  withRepo(({ dir, first, commit }) => {
    const head = commit(
      "packages/shared/src/home-summary.ts",
      "export const changed = true;",
    );
    const result = spawnSync(process.execPath, [vercelScript], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_PREVIOUS_SHA: first,
        VERCEL_GIT_COMMIT_SHA: head,
      },
    });
    assert.equal(result.status, 1);
  });
});

test("worker release guard allows later frontend changes but rejects later backend", () => {
  const bare = mkdtempSync(join(tmpdir(), "pce-deploy-origin-"));
  const guard = resolve("scripts/deploy/assert-worker-release-current.mjs");
  try {
    execFileSync("git", ["init", "--bare", "-q", bare]);
    withRepo(({ dir, git, commit }) => {
      git("remote", "add", "origin", bare);
      git("push", "-q", "origin", "HEAD:main");
      const backendRelease = commit("apps/api/src/main.ts", "backend-v1");
      git("push", "-q", "origin", "HEAD:main");
      commit("apps/web/page.ts", "frontend-v2");
      git("push", "-q", "origin", "HEAD:main");
      const check = () =>
        spawnSync(process.execPath, [guard, backendRelease], {
          cwd: dir,
          encoding: "utf8",
        });
      assert.equal(check().status, 0, "frontend update must not block worker");
      commit("packages/db/src/schema.ts", "backend-v2");
      git("push", "-q", "origin", "HEAD:main");
      assert.equal(check().status, 1, "newer backend invalidates stale worker");
    });
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
test("worker file reporter matches shared scope classification", () => {
  const reporter = resolve("scripts/deploy/report-worker-changes.mjs");
  withRepo(({ dir }) => {
    const file = join(dir, "paths.txt");
    const run = (paths) => {
      writeFileSync(file, paths.join("\n") + "\n");
      return spawnSync(process.execPath, [reporter, file], {
        cwd: dir,
        encoding: "utf8",
      });
    };
    assert.equal(
      run(["apps/web/src/app/page.ts"]).stdout.trim(),
      "backend=false",
    );
    assert.equal(
      run(["apps/worker/src/main.ts"]).stdout.trim(),
      "backend=true",
    );
    assert.equal(run(["README.md"]).stdout.trim(), "backend=false");
  });
});

test("Vercel skips unknown and non-main refs before diffing", () => {
  for (const ref of ["", "feature/example"]) {
    const result = spawnSync(process.execPath, [vercelScript], {
      encoding: "utf8",
      env: { ...process.env, VERCEL_GIT_COMMIT_REF: ref },
    });
    assert.equal(result.status, 0);
  }
});

test("Render ignores exactly the backend exclusions in the shared classifier", async () => {
  const { readFileSync } = await import("node:fs");
  const { backendIgnoredPaths } = await import("./change-scope.mjs");
  const yaml = readFileSync("render.yaml", "utf8");
  const block = yaml
    .split("      ignoredPaths:\n")[1]
    .split("    previews:")[0];
  const actual = [...block.matchAll(/^        - (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(actual, backendIgnoredPaths);
  for (const path of actual) {
    assert.equal(
      affectedServices([path.replace("/**", "/example")]).backend,
      false,
      path,
    );
  }
});
