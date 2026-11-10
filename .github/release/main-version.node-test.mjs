import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planMainVersions, publishMainVersions } from './main-version.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'pce-main-version-'));
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (path, contents) => {
    const file = join(repo, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, contents);
    git('add', path);
    git('commit', '-q', '-m', 'commit ' + path);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Release test');
    git('config', 'user.email', 'release@example.invalid');
    const old = commit('README.md', 'before release automation');
    const baseline = commit('.github/workflows/main-version.yml', 'name: main version');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    git('remote', 'add', 'origin', origin);
    run({ git, repo, origin, old, baseline, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('every first-parent main commit gets its deterministic ordinal; pre-existing history is excluded', () => {
  fixture(({ git, repo, old, baseline, commit }) => {
    const next = commit('docs/DEPLOYMENT.md', 'docs');
    git('checkout', '-q', '-b', 'feature');
    const feature1 = commit('apps/web/page.ts', 'feature one');
    const feature2 = commit('apps/web/another.ts', 'feature two');
    git('checkout', '-q', 'main');
    const nextMain = commit('apps/api/main.ts', 'api');
    git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    const merged = git('rev-parse', 'HEAD');

    const { head, releases, current } = planMainVersions(repo);
    assert.equal(head, merged);
    assert.deepEqual(releases.map(x => x.sha), [baseline, next, nextMain, merged]);
    for (const release of releases) {
      assert.equal(release.version, 'r' +
        git('rev-list', '--first-parent', '--count', release.sha).padStart(6, '0'));
    }
    assert.equal(current.sha, merged);
    assert.ok(!releases.some(x => [old, feature1, feature2].includes(x.sha)));
  });
});

test('publishes missing tags, safely reruns and backfills commits missed by an earlier workflow run', () => {
  fixture(({ git, repo, baseline, commit }) => {
    const frontend = commit('apps/web/page.ts', 'web');
    git('push', '-q', 'origin', 'HEAD:refs/heads/main');

    const first = publishMainVersions(repo);
    assert.equal(first.tagged, 2);
    assert.equal(first.checked, 2);
    assert.equal(git('rev-parse', first.current.version + '^{commit}'), frontend);
    assert.equal(git('rev-parse', 'r000002^{commit}'), baseline);

    assert.equal(publishMainVersions(repo).tagged, 0, 'rerun is idempotent');

    const docs = commit('docs/guide.md', 'docs');
    const backend = commit('apps/api/main.ts', 'backend');
    git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    const recovery = publishMainVersions(repo);
    assert.equal(recovery.tagged, 2, 'both intervening revisions are tagged');
    assert.equal(git('rev-parse', 'r000004^{commit}'), docs);
    assert.equal(git('rev-parse', 'r000005^{commit}'), backend);
    assert.equal(git('ls-remote', 'origin', 'refs/tags/r000005').split('\t')[0], backend);
  });
});

test('refuses to rewrite a conflicting existing tag', () => {
  fixture(({ git, repo, old }) => {
    git('tag', 'r000002', old);
    git('push', '-q', 'origin', 'refs/tags/r000002');
    git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    assert.throws(() => publishMainVersions(repo), /Tag collision: r000002/);
    assert.equal(git('ls-remote', 'origin', 'refs/tags/r000002').split('\t')[0], old);
    assert.equal(git('ls-remote', 'origin', 'refs/tags/r000003'), '');
  });
});

test('refuses to publish from a feature branch or stale main checkout', () => {
  fixture(({ git, repo, commit }) => {
    git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    git('checkout', '-q', '-b', 'feature');
    commit('docs/feature.md', 'feature only');
    assert.throws(() => publishMainVersions(repo), /other than local main/);
    git('checkout', '-q', 'main');
    commit('docs/not-pushed.md', 'not yet on remote');
    assert.throws(() => publishMainVersions(repo), /does not match origin\/main/);
  });
});

test('cannot create a release plan before workflow introduction', () => {
  fixture(({ git, repo, old }) => {
    git('checkout', '-q', '--detach', old);
    assert.throws(() => planMainVersions(repo), /Cannot locate the original main commit/);
  });
});
