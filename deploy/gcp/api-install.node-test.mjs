import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const linux = { skip: process.platform !== "linux" && "GNU utilities exercised in Linux CI" };
const revision = "a".repeat(40);
async function fixture(t, previous = false) {
  const dir = await mkdtemp(join(tmpdir(), "pce-api-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sub of ["releases", "bin", "package/runtime", "package/apps/api/dist"])
    await mkdir(join(dir, sub), { recursive: true });
  // Rewrite only operator paths/root check in a temporary copy: tests cannot
  // touch real service/config paths and production has no test override knobs.
  const source = (await readFile("deploy/gcp/api-install.sh", "utf8"))
    .replace("$EUID == 0 && ", "")
    .replace("root=/opt/pce-api", `root='${dir}'`)
    .replaceAll("/etc/pce/api-ready", join(dir, "ready"));
  await writeFile(join(dir, "install.sh"), source);
  await writeFile(join(dir, "ready"), "synthetic approval");
  await writeFile(join(dir, "package/REVISION"), revision);
  await writeFile(join(dir, "package/apps/api/dist/main.js"), "");
  await writeFile(join(dir, "package/runtime/node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(dir, "bin/chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(dir, "bin/systemctl"), `#!/bin/bash
echo "$*" >> "$CONTROL_LOG"
if [[ $1 == restart && ! -f $CONTROL_LOG.failed ]]; then
  if [[ $FAIL_MODE == restart ]]; then touch "$CONTROL_LOG.failed"; exit 1; fi
  if [[ $FAIL_MODE == signal ]]; then touch "$CONTROL_LOG.failed"; kill -TERM "$PPID"; exit 0; fi
fi
`, { mode: 0o755 });
  await writeFile(join(dir, "bin/curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (previous) {
    await mkdir(join(dir, "releases/previous"));
    await symlink(join(dir, "releases/previous"), join(dir, "current"));
  }
  const archive = join(dir, "api.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", join(dir, "package"), "."]).status, 0);
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  return { dir, archive, digest, run: (mode = "", hash = digest) => spawnSync("bash", [join(dir, "install.sh"), revision, archive, hash], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, CONTROL_LOG: join(dir, "calls"), FAIL_MODE: mode },
  }) };
}
test("API activates verified revision without worker lifecycle calls", linux, async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(await readlink(join(f.dir, "current")), join(f.dir, "releases", revision));
  assert.doesNotMatch(await readFile(join(f.dir, "calls"), "utf8"), /worker/);
});
test("API rejects checksum mismatch before activation", linux, async t => {
  const f = await fixture(t);
  assert.notEqual(f.run("", "0".repeat(64)).status, 0);
  await assert.rejects(access(join(f.dir, "current")));
});
test("API requires explicit readiness marker", linux, async t => {
  const f = await fixture(t);
  await rm(join(f.dir, "ready"));
  assert.notEqual(f.run().status, 0);
  await assert.rejects(access(join(f.dir, "current")));
});
for (const failure of ["restart", "signal"]) {
  test(`API restores previous revision after ${failure} failure`, linux, async t => {
    const f = await fixture(t, true);
    assert.notEqual(f.run(failure).status, 0);
    assert.equal(await readlink(join(f.dir, "current")), join(f.dir, "releases/previous"));
    await assert.rejects(access(join(f.dir, "releases", revision)));
  });
}
test("failed first API activation stops API and removes current", linux, async t => {
  const f = await fixture(t);
  assert.notEqual(f.run("restart").status, 0);
  await assert.rejects(access(join(f.dir, "current")));
  assert.match(await readFile(join(f.dir, "calls"), "utf8"), /stop pce-api.service/);
});
test("API refuses escaping archive links", linux, async t => {
  const f = await fixture(t);
  await symlink("../../escape", join(f.dir, "package/escape"));
  assert.equal(spawnSync("tar", ["-czf", f.archive, "-C", join(f.dir, "package"), "."]).status, 0);
  const hash = createHash("sha256").update(await readFile(f.archive)).digest("hex");
  assert.notEqual(f.run("", hash).status, 0);
  await assert.rejects(access(join(f.dir, "current")));
});
