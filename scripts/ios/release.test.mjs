import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, publicEnvironment, auditFiles } from "./release.mjs";
import { makeSource } from "./source.mjs";
const publicConfig = {
  EXPO_PUBLIC_API_BASE_URL: "https://api.example.test",
  EXPO_PUBLIC_OAUTH_CLIENT_ID: "native-test",
  EXPO_PUBLIC_PCE_TASKS: "true",
};
test("release rejects malformed or repeated arguments before invoking tools", () => {
  for (const args of [
    ["--build", "0"],
    ["--build", "1;bad"],
    ["--version", "1"],
    ["--device"],
    ["--unknown"],
    ["--build", "1", "--build", "2"],
  ])
    assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(["--install", "--build", "2"]).install, true);
});
test("build only receives approved public settings, preserving Tasks and excluding credentials", () => {
  const env = publicEnvironment(
    { ...publicConfig, DATABASE_URL: "secret" },
    {
      PATH: "/bin",
      GITHUB_TOKEN: "secret",
      NODE_OPTIONS: "unsafe",
      EXPO_TOKEN: "secret",
    },
  );
  assert.equal(env.EXPO_PUBLIC_PCE_TASKS, "true");
  for (const key of [
    "DATABASE_URL",
    "GITHUB_TOKEN",
    "NODE_OPTIONS",
    "EXPO_TOKEN",
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.EXPO_NO_DOTENV, "1");
  assert.throws(() =>
    publicEnvironment({ ...publicConfig, EXPO_PUBLIC_UNKNOWN: "secret" }, {}),
  );
  assert.throws(() =>
    publicEnvironment(
      { ...publicConfig, EXPO_PUBLIC_API_BASE_URL: "http://localhost" },
      {},
    ),
  );
});
test("payload guard rejects nested private files and links", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pce-release-test-"));
  try {
    mkdirSync(path.join(directory, "assets"));
    writeFileSync(path.join(directory, "assets", ".env.local"), "synthetic");
    assert.throws(() => auditFiles(directory));
    rmSync(path.join(directory, "assets", ".env.local"));
    symlinkSync("missing", path.join(directory, "assets", "link"));
    assert.throws(() => auditFiles(directory));
    rmSync(path.join(directory, "assets", "link"));
    auditFiles(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("source uses actual release version, build, permissions, digest and notes; requires HTTPS", () => {
  const metadata = {
    bundleIdentifier: "dev.pce.mobile",
    ipa: "PCE-0.1.0-2.ipa",
    version: "0.1.0",
    build: "2",
    builtAt: "2026-11-05T10:00:00Z",
    notes: "Synthetic release",
    size: 100,
    sha256: "a".repeat(64),
    minimumOSVersion: "15.1",
  };
  const permissions = { entitlements: ["get-task-allow"], privacy: {} };
  const source = makeSource(
    metadata,
    "https://private.example.test/releases",
    permissions,
  );
  assert.equal(
    source.apps[0].versions[0].downloadURL,
    "https://private.example.test/releases/PCE-0.1.0-2.ipa",
  );
  assert.equal(source.apps[0].versions[0].buildVersion, "2");
  assert.deepEqual(source.apps[0].appPermissions, permissions);
  for (const url of [
    "http://example.test",
    "https://name:password@example.test",
    "https://example.test/?token=secret",
  ])
    assert.throws(() => makeSource(metadata, url, permissions));
  assert.throws(() =>
    makeSource(
      { ...metadata, ipa: "../secret.ipa" },
      "https://example.test",
      permissions,
    ),
  );
});
