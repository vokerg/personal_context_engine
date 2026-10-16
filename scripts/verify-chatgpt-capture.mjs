#!/usr/bin/env node
/**
 * Validate an isolated, synthetic ChatGPT Project capture export against the
 * executable v1 note contract. Never prints file names, note text or tokens.
 *
 * Usage: npm run capture:verify -- <export-directory> <manifest.json>
 * The export directory must contain only the expected inbox/ Markdown files.
 * This is an OFFLINE checker, not evidence of a live Project or GitHub write.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  groupNotesByCapture,
  NoteValidationError,
  parseNoteMarkdown,
  verifyInboxNotePath,
} from "../packages/core/dist/index.js";

export class ExperimentValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ExperimentValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ExperimentValidationError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectMetadata(actual, expected) {
  if (
    !isRecord(expected) ||
    typeof expected.kind !== "string" ||
    typeof expected.action_hint !== "string" ||
    typeof expected.review_required !== "boolean" ||
    !Object.hasOwn(expected, "due_at")
  ) {
    fail("INVALID_MANIFEST");
  }
  const allowed = new Set([
    "kind", "action_hint", "review_required", "due_at",
    "projects", "source", "timezone",
  ]);
  if (Object.keys(expected).some((key) => !allowed.has(key))) {
    fail("INVALID_MANIFEST");
  }
  if (
    expected.due_at !== null && typeof expected.due_at !== "string" ||
    expected.projects !== undefined && (
      !Array.isArray(expected.projects) ||
      !expected.projects.every((value) => typeof value === "string")
    ) ||
    expected.source !== undefined && typeof expected.source !== "string" ||
    expected.timezone !== undefined && typeof expected.timezone !== "string"
  ) {
    fail("INVALID_MANIFEST");
  }
  for (const field of Object.keys(expected)) {
    const value = actual[field] ?? null;
    if (JSON.stringify(value) !== JSON.stringify(expected[field])) {
      fail("METADATA_MISMATCH");
    }
  }
}

function verifyManifest(manifest) {
  if (
    !isRecord(manifest) ||
    manifest.schema_version !== 1 ||
    Object.keys(manifest).some((key) => !["schema_version", "scenarios"].includes(key)) ||
    !Array.isArray(manifest.scenarios) ||
    manifest.scenarios.length === 0 ||
    manifest.scenarios.length > 30
  ) {
    fail("INVALID_MANIFEST");
  }
  const scenarioNames = new Set();
  const allPaths = new Set();
  for (const scenario of manifest.scenarios) {
    if (
      !isRecord(scenario) ||
      Object.keys(scenario).some(
        (key) => !["name", "original_input", "files", "expected_notes"].includes(key),
      ) ||
      typeof scenario.name !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(scenario.name) ||
      scenarioNames.has(scenario.name) ||
      typeof scenario.original_input !== "string" ||
      !scenario.original_input.trim() ||
      !Array.isArray(scenario.files) ||
      !Array.isArray(scenario.expected_notes) ||
      scenario.files.length === 0 ||
      scenario.files.length !== scenario.expected_notes.length ||
      scenario.files.length > 20
    ) {
      fail("INVALID_MANIFEST");
    }
    scenarioNames.add(scenario.name);
    for (const path of scenario.files) {
      if (
        typeof path !== "string" ||
        !/^inbox\/[0-9]{4}-[0-9]{2}-[0-9]{2}_[A-Za-z0-9-]+\.md$/.test(path) ||
        allPaths.has(path)
      ) {
        fail("INVALID_MANIFEST");
      }
      allPaths.add(path);
    }
    for (const expected of scenario.expected_notes) {
      // Validate expectation shape even if no notes exist at the given path.
      expectMetadata(
        { ...expected, due_at: expected?.due_at ?? null },
        expected,
      );
    }
  }
  return allPaths;
}

/**
 * Purely reads an isolated export; no repository access or writes.
 * Returns counts only, so callers never need to log sensitive content.
 */
export async function verifyCaptureExperiment(exportDirectory, manifest) {
  const paths = verifyManifest(manifest);
  const root = resolve(exportDirectory);
  const rootStat = await lstat(root);
  const inboxStat = await lstat(join(root, "inbox"));
  if (!rootStat.isDirectory() || !inboxStat.isDirectory()) {
    fail("UNSAFE_EXPORT_DIRECTORY");
  }
  const entries = await readdir(join(root, "inbox"), { withFileTypes: true });
  if (
    entries.length !== paths.size ||
    entries.some(
      (entry) => !entry.isFile() || !paths.has("inbox/" + entry.name),
    )
  ) {
    fail("UNEXPECTED_INBOX_ENTRY");
  }

  const usedIds = new Set();
  const usedCaptureIds = new Set();
  let noteCount = 0;

  for (const scenario of manifest.scenarios) {
    const notes = [];
    for (const [index, path] of scenario.files.entries()) {
      const fullPath = join(root, ...path.split("/"));
      const stat = await lstat(fullPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        fail("INVALID_EXPORT_FILE");
      }
      // Buffer input enforces the parser's strict UTF-8 rules.
      const note = parseNoteMarkdown(await readFile(fullPath));
      verifyInboxNotePath(path, note.metadata);
      if (note.originalInput !== scenario.original_input) {
        fail("ORIGINAL_INPUT_MISMATCH");
      }
      expectMetadata(note.metadata, scenario.expected_notes[index]);
      if (usedIds.has(note.metadata.id)) {
        fail("DUPLICATE_NOTE_ID");
      }
      usedIds.add(note.metadata.id);
      notes.push(note);
      noteCount++;
    }
    const captures = groupNotesByCapture(notes);
    if (captures.length !== 1 || captures[0].notes.length !== scenario.files.length) {
      fail("CAPTURE_GROUP_MISMATCH");
    }
    if (usedCaptureIds.has(captures[0].id)) {
      fail("DUPLICATE_CAPTURE_ID");
    }
    usedCaptureIds.add(captures[0].id);
  }
  return { captures: usedCaptureIds.size, notes: noteCount };
}

async function main() {
  if (process.argv.length !== 4) {
    console.error("Usage: npm run capture:verify -- <export-directory> <manifest.json>");
    process.exitCode = 2;
    return;
  }
  try {
    const manifest = JSON.parse(await readFile(resolve(process.argv[3]), "utf8"));
    const result = await verifyCaptureExperiment(process.argv[2], manifest);
    console.log("PASS: " + result.captures + " synthetic captures, " + result.notes + " notes");
  } catch (error) {
    const code =
      error instanceof ExperimentValidationError ||
      error instanceof NoteValidationError
        ? error.code
        : "INPUT_OR_IO_FAILURE";
    console.error("FAIL: " + code + " (no note content displayed)");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
