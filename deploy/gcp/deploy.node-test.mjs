import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  symlink,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const script = resolve("deploy/gcp/deploy.sh");
const linux = {
  skip:
    process.platform !== "linux"
      ? "Uses Linux flock/GNU coreutils; exercised by the CI packaging job"
      : false,
};
const sha = "a".repeat(40),
  old = `${"b".repeat(40)}-1-1`,
  release = `${sha}-2-1`;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pce-deploy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sub of [
    "releases",
    "incoming",
    "bin",
    "package/runtime",
    "package/apps/worker/dist",
    "package/node_modules",
  ])
    await mkdir(join(dir, sub), { recursive: true });
  await writeFile(join(dir, "ready"), "operator-approved fixture");
  await writeFile(join(dir, "package/REVISION"), sha);
  await writeFile(join(dir, "package/apps/worker/dist/main.js"), "");
  await writeFile(
    join(dir, "package/runtime/node"),
    '#!/bin/sh\nif [ "$1" = -p ]; then echo 22; fi\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, "bin/sudo"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$CONTROL_LOG"
if [[ $FAIL_RESTART == true && \${*: -1} == restart && ! -f $FAILED_ONCE ]]; then
  touch "$FAILED_ONCE"; exit 1
fi
`,
    { mode: 0o755 },
  );
  const realPython = spawnSync("which", ["python3"], {
    encoding: "utf8",
  }).stdout.trim();
  const archive = join(dir, "incoming", `${release}.tar.gz`);
  assert.equal(
    spawnSync("tar", ["-czf", archive, "-C", join(dir, "package"), "."]).status,
    0,
  );
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const env = {
    ...process.env,
    PATH: `${dir}/bin:${process.env.PATH}`,
    PCE_DEPLOY_ROOT: dir,
    PCE_READY_FILE: join(dir, "ready"),
    REAL_PYTHON: realPython,
    CONTROL_LOG: join(dir, "calls"),
    FAIL_RESTART: "false",
    FAILED_ONCE: join(dir, "failed-once"),
  };
  return {
    dir,
    env,
    digest,
    archive,
    run: (op = "deploy", id = release, hash = digest) =>
      spawnSync("bash", [script, op, id, hash], { env, encoding: "utf8" }),
  };
}
async function previous(dir) {
  await mkdir(join(dir, "releases", old, "runtime"), { recursive: true });
  await writeFile(join(dir, "releases", old, ".complete"), "");
  await writeFile(join(dir, "releases", old, "REVISION"), "b".repeat(40));
  await writeFile(
    join(dir, "releases", old, "runtime/node"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
  await symlink(join(dir, "releases", old), join(dir, "current"));
}
test(
  "deployment activates a complete release, preserves external configuration and removes upload",
  linux,
  async (t) => {
    const f = await fixture(t);
    await previous(f.dir);
    await writeFile(join(f.dir, "private-config"), "untouched");
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      await readlink(join(f.dir, "current")),
      join(f.dir, "releases", release),
    );
    assert.equal(
      await readlink(join(f.dir, "previous")),
      join(f.dir, "releases", old),
    );
    assert.equal(
      await readFile(join(f.dir, "private-config"), "utf8"),
      "untouched",
    );
    assert.deepEqual(await readdir(join(f.dir, "incoming")), []);
  },
);
test(
  "failed restart restores and restarts previous release, returning failure",
  linux,
  async (t) => {
    const f = await fixture(t);
    await previous(f.dir);
    f.env.FAIL_RESTART = "true";
    const r = f.run();
    assert.equal(r.status, 1, r.stderr);
    assert.equal(
      await readlink(join(f.dir, "current")),
      join(f.dir, "releases", old),
    );
    assert.equal(
      (await readFile(join(f.dir, "calls"), "utf8")).match(/ restart/g)?.length,
      2,
    );
  },
);
test(
  "first deployment failure stops the service and removes current link",
  linux,
  async (t) => {
    const f = await fixture(t);
    f.env.FAIL_RESTART = "true";
    const r = f.run();
    assert.equal(r.status, 1, r.stderr);
    assert.equal(
      await readlink(join(f.dir, "current")).catch(() => null),
      null,
    );
    assert.match(await readFile(join(f.dir, "calls"), "utf8"), / stop/);
  },
);
test(
  "bad checksum leaves current untouched without restarting",
  linux,
  async (t) => {
    const f = await fixture(t);
    await previous(f.dir);
    assert.notEqual(f.run("deploy", release, "0".repeat(64)).status, 0);
    assert.equal(
      await readlink(join(f.dir, "current")),
      join(f.dir, "releases", old),
    );
    assert.equal(
      await readFile(join(f.dir, "calls"), "utf8").catch(() => ""),
      "",
    );
  },
);
test("archive traversal is rejected before activation", linux, async (t) => {
  const f = await fixture(t);
  assert.equal(
    spawnSync(f.env.REAL_PYTHON, [
      "-c",
      `import tarfile,io,sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
 m=tarfile.TarInfo('../escape'); m.size=1; t.addfile(m,io.BytesIO(b'x'))`,
      f.archive,
    ]).status,
    0,
  );
  const digest = createHash("sha256")
    .update(await readFile(f.archive))
    .digest("hex");
  const r = f.run("deploy", release, digest);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Invalid archive path/);
});
test(
  "rollback switches an existing complete release without installing dependencies",
  linux,
  async (t) => {
    const f = await fixture(t);
    await previous(f.dir);
    assert.equal(f.run().status, 0);
    const r = f.run("rollback", old);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      await readlink(join(f.dir, "current")),
      join(f.dir, "releases", old),
    );
  },
);

test(
  "prepare removes abandoned uploads/staging without touching current release",
  linux,
  async (t) => {
    const f = await fixture(t);
    await previous(f.dir);
    await mkdir(join(f.dir, "releases/.staging.abandoned"));
    const r = f.run("prepare");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(await readdir(join(f.dir, "incoming")), []);
    assert.equal(
      await readlink(join(f.dir, "current")),
      join(f.dir, "releases", old),
    );
    assert.ok(
      !(await readdir(join(f.dir, "releases"))).includes(".staging.abandoned"),
    );
  },
);

test(
  "rollback rejects an interrupted incomplete release without switching",
  linux,
  async (t) => {
    const f = await fixture(t);
    await previous(f.dir);
    await rm(join(f.dir, "releases", old, ".complete"));
    const r = f.run("rollback", old);
    assert.notEqual(r.status, 0);
    assert.equal(
      await readFile(join(f.dir, "calls"), "utf8").catch(() => ""),
      "",
    );
  },
);

test(
  "missing readiness marker never switches or restarts a service",
  linux,
  async (t) => {
    const f = await fixture(t);
    await previous(f.dir);
    await rm(join(f.dir, "ready"));
    assert.notEqual(f.run().status, 0);
    assert.equal(
      await readlink(join(f.dir, "current")),
      join(f.dir, "releases", old),
    );
    assert.equal(
      await readFile(join(f.dir, "calls"), "utf8").catch(() => ""),
      "",
    );
  },
);

test(
  "escaping archive symlink is rejected before extraction",
  linux,
  async (t) => {
    const f = await fixture(t);
    assert.equal(
      spawnSync(f.env.REAL_PYTHON, [
        "-c",
        `import tarfile,sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
 m=tarfile.TarInfo('escape'); m.type=tarfile.SYMTYPE; m.linkname='../../outside'; t.addfile(m)`,
        f.archive,
      ]).status,
      0,
    );
    const digest = createHash("sha256")
      .update(await readFile(f.archive))
      .digest("hex");
    const result = f.run("deploy", release, digest);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Archive link escapes release/);
    assert.equal(
      await readFile(join(f.dir, "calls"), "utf8").catch(() => ""),
      "",
    );
  },
);
