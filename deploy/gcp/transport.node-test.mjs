import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const script = resolve("deploy/gcp/ssh-operation.sh");
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pce-transport-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  await writeFile(
    join(dir, "gcloud"),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    CALL_LOG: log,
    GCP_PROJECT_ID: "example-project",
    GCP_VM_NAME: "example-vm",
    GCP_VM_ZONE: "us-east1-b",
    GCP_KNOWN_HOSTS_FILE: join(dir, "known_hosts"),
    GCP_SSH_KNOWN_HOSTS: "compute.123 ssh-ed25519 EXAMPLE",
  };
  return { env, log, dir };
}
for (const op of ["start", "stop", "restart", "status"]) {
  test(`${op} uses IAP, host pinning and only the fixed service helper`, async (t) => {
    const { env, log } = await fixture(t);
    const result = spawnSync("bash", [script, op], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const call = await readFile(log, "utf8");
    assert.match(call, /--tunnel-through-iap/);
    assert.match(call, /--strict-host-key-checking=yes/);
    assert.equal(
      await readFile(env.GCP_KNOWN_HOSTS_FILE, "utf8"),
      "compute.123 ssh-ed25519 EXAMPLE\n",
    );
    assert.match(call, new RegExp(`pce-worker-control ${op}`));
    assert.doesNotMatch(
      call,
      /compute scp|worker-deploy|setMetadata|set-metadata/,
    );
  });
}
test("shell metacharacters and unknown operations never reach gcloud", async (t) => {
  const { env, log } = await fixture(t);
  for (const op of ["rollback", "deploy;id", "poweroff"]) {
    assert.equal(spawnSync("bash", [script, op], { env }).status, 2);
  }
  env.GCP_VM_NAME = "bad;id";
  assert.equal(spawnSync("bash", [script, "status"], { env }).status, 2);
  assert.equal(await readFile(log, "utf8").catch(() => ""), "");
});

test("deploy verifies the artifact and prepares storage before upload and activation", async (t) => {
  const { env, log, dir } = await fixture(t);
  const { createHash } = await import("node:crypto");
  const archive = Buffer.from("test artifact");
  const digest = createHash("sha256").update(archive).digest("hex");
  await writeFile(join(dir, "worker.tar.gz"), archive);
  await writeFile(
    join(dir, "worker.tar.gz.sha256"),
    `${digest}  worker.tar.gz\n`,
  );
  Object.assign(env, {
    ARTIFACT_DIR: dir,
    RELEASE_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  });
  const result = spawnSync("bash", [script, "deploy"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.length, 3);
  assert.match(calls[0], /worker-deploy prepare/);
  assert.match(calls[1], /compute scp/);
  assert.match(
    calls[2],
    new RegExp(`worker-deploy deploy a{40}-123-1 ${digest}`),
  );
  assert.ok(calls.every((call) => call.includes("--tunnel-through-iap")));
});
