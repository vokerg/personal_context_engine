/**
 * Tags each first-parent main revision since the merge that introduced this workflow.
 * The sequence number is the first-parent commit ordinal, not a mutable counter.
 * Re-running the workflow fills missed tags without rewriting existing ones.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const WORKFLOW_PATH = '.github/workflows/main-version.yml';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tagCommit(cwd, tag) {
  try {
    return git(cwd, 'rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}');
  } catch (error) {
    // Exit 128 is Git's "reference does not exist"; other errors are not a missing tag.
    if (error.status === 128) return null;
    throw error;
  }
}

export function planMainVersions(cwd = process.cwd()) {
  const history = git(cwd, 'rev-list', '--first-parent', '--reverse', 'HEAD').split('\n');
  const introductions = git(
    cwd, 'log', '--first-parent', '--diff-filter=A', '--format=%H', '--', WORKFLOW_PATH,
  ).split('\n').filter(Boolean);
  if (introductions.length === 0) {
    throw new Error('Cannot locate the original main commit introducing ' + WORKFLOW_PATH);
  }

  const first = history.indexOf(introductions.at(-1));
  if (first < 0) {
    throw new Error('Workflow introduction is not on the current first-parent history');
  }
  const releases = history.slice(first).map((sha, offset) => ({
    sha,
    version: 'r' + String(first + offset + 1).padStart(6, '0'),
  }));
  return { head: history.at(-1), releases, current: releases.at(-1) };
}

export function publishMainVersions(cwd = process.cwd()) {
  if (git(cwd, 'symbolic-ref', '--short', 'HEAD') !== 'main') {
    throw new Error('Refusing to publish versions from anything other than local main');
  }

  const remoteLine = git(cwd, 'ls-remote', '--heads', 'origin', 'main');
  const remoteHead = remoteLine.match(/^([0-9a-f]{40})\trefs\/heads\/main$/)?.[1];
  const { head, releases, current } = planMainVersions(cwd);
  if (remoteHead !== head) {
    throw new Error('Local main does not match origin/main; retry on fresh main');
  }

  // A previous run may have published tags after checkout. Never overwrite them.
  git(cwd, 'fetch', '--quiet', '--tags', 'origin');
  const missing = [];
  for (const release of releases) {
    const existing = tagCommit(cwd, release.version);
    if (existing && existing !== release.sha) {
      throw new Error(
        'Tag collision: ' + release.version + ' points to ' + existing +
        ' instead of ' + release.sha + '. Refusing to rewrite history.',
      );
    }
    if (!existing) missing.push(release);
  }

  for (const release of missing) {
    git(cwd, 'tag', release.version, release.sha);
  }
  if (missing.length > 0) {
    // Atomic push prevents partial publication when the remote supports it (GitHub does).
    git(cwd, 'push', '--atomic', 'origin', ...missing.map(x => 'refs/tags/' + x.version));
  }
  return { current, tagged: missing.length, checked: releases.length };
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--publish') {
    throw new Error('Usage: node .github/release/main-version.mjs --publish');
  }
  if (process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_REPOSITORY !== 'vokerg/personal_context_engine') {
    throw new Error('Release tagging requires the canonical main branch workflow');
  }
  const { current, tagged, checked } = publishMainVersions();
  const output = 'version=' + current.version + '\n' +
    'sha=' + current.sha + '\n' +
    'tagged=' + tagged + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      '### PCE main version: ' + current.version + '\n\n' +
      '- Commit: \`' + current.sha + '\`\n' +
      '- Newly tagged: ' + tagged + '\n' +
      '- Checked since versioning started: ' + checked + '\n\n' +
      'These tags identify source commits; deployment status is tracked separately.\n',
    );
  }
  process.stdout.write(current.version + ' ' + current.sha + ' (new tags: ' + tagged + ')\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
