#!/usr/bin/env node
/**
 * Minimal, dependency-free documentation guardrail for the public repo.
 * Validates required entry points and local Markdown link destinations.
 * Does not read or contact the private content repository.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = [
  'README.md',
  'AGENTS.md',
  'docs/README.md',
  ...Array.from({ length: 12 }, (_, index) => {
    const name = [
      '01-vision',
      '02-architecture',
      '03-repositories-and-operations',
      '04-capture-contract',
      '05-ingestion',
      '06-domain-and-taxonomy',
      '07-ledgers',
      '08-clients-and-notifications',
      '09-security-and-privacy',
      '10-roadmap',
      '11-decisions',
      '12-chatgpt-project',
    ][index];
    return `docs/${name}.md`;
  }),
];

const errors = [];
for (const filename of required) {
  if (!existsSync(join(root, filename))) errors.push(`Missing: ${filename}`);
}

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (['.git', 'node_modules'].includes(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) found.push(full);
  }
  return found;
}

let linkCount = 0;
for (const filename of markdownFiles(root)) {
  const body = readFileSync(filename, 'utf8');
  const links = body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
  for (const [, destination] of links) {
    const target = destination.split('#')[0].trim();
    if (!target || /^(https?:|mailto:)/i.test(target)) continue;
    if (target.startsWith('/')) {
      errors.push(`Absolute local link in ${relative(root, filename)}: ${destination}`);
      continue;
    }
    const decoded = decodeURIComponent(target);
    const local = resolve(dirname(filename), decoded);
    const withinRoot = relative(root, local);
    if (withinRoot === '..' || withinRoot.startsWith('..' + sep) || isAbsolute(withinRoot)) {
      errors.push(`Link escapes repository in ${relative(root, filename)}: ${destination}`);
    } else if (!existsSync(local)) {
      errors.push(`Broken link in ${relative(root, filename)}: ${destination}`);
    }
    linkCount++;
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  console.error(`Documentation check failed (${errors.length} errors).`);
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed: ${required.length} required files, ${linkCount} local links.`);
}
