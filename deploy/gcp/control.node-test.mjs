import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("deploy/gcp/control.sh");
async function run(t, action, state = "active", unstable = false) {
  const root = await mkdtemp(join(tmpdir(), "pce-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = join(root, "systemctl");
  const log = join(root, "commands");
  await writeFile(
    mock,
    `#!/bin/bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$1" in
  start|restart) echo active > "$STATE_FILE" ;;
  stop) echo inactive > "$STATE_FILE" ;;
  is-active) [[ $(cat "$STATE_FILE") == active ]] ;;
  show)
    case "$3" in
      --property=MainPID) echo 123 ;;
      --property=NRestarts) if [[ $UNSTABLE == true ]]; then date +%s%N; else echo 0; fi ;;
      --property=ActiveState) cat "$STATE_FILE" ;;
      *) echo 'ActiveState=active' ;;
    esac ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(join(root, "state"), state);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
function systemctl() { "$MOCK" "$@"; }
function journalctl() { echo 'recent systemd lifecycle log'; }
function sleep() { :; }
export -f systemctl journalctl sleep
exec bash "$CONTROL_SCRIPT" "$ACTION"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MOCK: mock,
        COMMAND_LOG: log,
        STATE_FILE: join(root, "state"),
        UNSTABLE: String(unstable),
        CONTROL_SCRIPT: script,
        ACTION: action,
      },
    },
  );
  return { ...result, commands: await readFile(log, "utf8").catch(() => "") };
}
for (const action of ["start", "stop", "restart", "status"]) {
  test(`control ${action} succeeds without deploying or stopping VM`, async (t) => {
    const r = await run(t, action);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(
      r.commands,
      /reboot|poweroff|shutdown|enable|daemon-reload/,
    );
    if (action !== "status")
      assert.match(r.commands, new RegExp(`${action} pce-worker.service`));
  });
}
test("inactive status is an explicit failure with recent lifecycle logs", async (t) => {
  const r = await run(t, "status", "inactive");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /recent systemd lifecycle log/);
});
test("restart loop fails health verification", async (t) => {
  const r = await run(t, "restart", "active", true);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /recent systemd lifecycle log/);
});
test("invalid control input is rejected before any systemctl command", async (t) => {
  const r = await run(t, "deploy; shutdown");
  assert.equal(r.status, 2);
  assert.equal(r.commands, "");
});
