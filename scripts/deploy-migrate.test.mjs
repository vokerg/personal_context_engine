import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./deploy-migrate.mjs", import.meta.url));
describe("hosted migration connection and diagnostic boundary", () => {
  const pooled = "postgresql://synthetic:fake@pool.invalid/pce";
  const direct = "postgresql://synthetic:fake@direct.invalid/pce";
  function run(env = {}) {
    const dir = mkdtempSync(join(tmpdir(), "pce-migration-"));
    const observed = join(dir, "observed.json");
    try {
      writeFileSync(
        join(dir, "npm"),
        `#!${process.execPath}\nimport('node:fs').then(({writeFileSync}) => {writeFileSync(process.env.OBSERVED, JSON.stringify({args:process.argv.slice(2),url:process.env.DATABASE_URL})); console.error('synthetic-private-provider-diagnostic'); process.exit(Number(process.env.MIGRATION_EXIT ?? '0'));});\n`,
        { mode: 0o700 },
      );
      const result = spawnSync(process.execPath, [script], {
        env: { PATH: dir, OBSERVED: observed, ...env },
        encoding: "utf8",
      });
      let invocation;
      try {
        invocation = JSON.parse(readFileSync(observed, "utf8"));
      } catch {}
      return { ...result, invocation };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it("uses the direct URL for migration without exposing diagnostics", () => {
    const result = run({ DATABASE_URL: pooled, DIRECT_URL: direct });
    expect(result.status).toBe(0);
    expect(result.invocation).toEqual({
      args: ["run", "db:migrate"],
      url: direct,
    });
    expect(result.stdout + result.stderr).not.toContain("synthetic-private");
    expect(result.stdout + result.stderr).not.toContain(direct);
  });
  it("falls back to the configured runtime URL when no direct URL is provided", () => {
    const result = run({ DATABASE_URL: pooled });
    expect(result.status).toBe(0);
    expect(result.invocation.url).toBe(pooled);
  });
  it("fails closed for missing connection or failed migration with fixed diagnostics", () => {
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.invocation).toBeUndefined();
    const failed = run({ DATABASE_URL: pooled, MIGRATION_EXIT: "1" });
    expect(failed.status).toBe(1);
    expect(failed.stdout + failed.stderr).not.toContain("synthetic-private");
    expect(failed.stdout + failed.stderr).not.toContain(pooled);
  });
});
