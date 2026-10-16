import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serializeNoteMarkdown } from "../packages/core/dist/index.js";
import {
  ExperimentValidationError,
  verifyCaptureExperiment,
} from "./verify-chatgpt-capture.mjs";

const CAPTURE = "01K00000000000000000000000";
const NOTE_A = "01K00000000000000000000001";
const NOTE_B = "01K00000000000000000000002";
const NOTE_C = "01K00000000000000000000003";
const ORIGINAL = "Nápad první. Second idea. 日本語の三番目。\n";
const roots = [];
const timestamp = "2026-10-16T19:30:00+02:00";

function pathFor(id) {
  return "inbox/2026-10-16_" + id + ".md";
}

function makeMarkdown(id, captureId = CAPTURE, original = ORIGINAL) {
  const metadata = {
    schema_version: 1,
    id,
    capture_id: captureId,
    captured_at: timestamp,
    source: "chatgpt_text",
    kind: "idea",
    domains: [],
    projects: [],
    tags: [],
    action_hint: "consider",
    review_required: false,
    title: "Synthetic idea",
    timezone: "Europe/Prague",
  };
  const summary = "Three unrelated synthetic ideas.";
  const body =
    "\n# Synthetic idea\n\n## Summary\n\n" +
    summary +
    "\n\n## Original input\n\n" +
    original;
  return serializeNoteMarkdown({
    metadata,
    summary,
    originalInput: original,
    body,
  });
}

function expected() {
  return {
    kind: "idea",
    action_hint: "consider",
    review_required: false,
    due_at: null,
    projects: [],
    source: "chatgpt_text",
    timezone: "Europe/Prague",
  };
}

async function fixture(ids = [NOTE_A]) {
  const root = await mkdtemp(join(tmpdir(), "pce-synthetic-capture-"));
  roots.push(root);
  await mkdir(join(root, "inbox"));
  for (const id of ids) {
    await writeFile(join(root, pathFor(id)), makeMarkdown(id));
  }
  const manifest = {
    schema_version: 1,
    scenarios: [{
      name: "synthetic-multi-idea",
      original_input: ORIGINAL,
      files: ids.map(pathFor),
      expected_notes: ids.map(expected),
    }],
  };
  return { root, manifest };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("offline ChatGPT Project capture verification", () => {
  it("validates three distinct notes in one capture with exact multilingual input", async () => {
    const { root, manifest } = await fixture([NOTE_A, NOTE_B, NOTE_C]);
    expect(await verifyCaptureExperiment(root, manifest)).toEqual({ captures: 1, notes: 3 });
  });

  it("detects a missing idea and unexpected extra files in the isolated export", async () => {
    const { root, manifest } = await fixture([NOTE_A, NOTE_B]);
    manifest.scenarios[0].files.pop();
    manifest.scenarios[0].expected_notes.pop();
    await expect(verifyCaptureExperiment(root, manifest)).rejects.toThrow("UNEXPECTED_INBOX_ENTRY");
  });

  it("rejects altered original transcript without echoing private text", async () => {
    const { root, manifest } = await fixture();
    manifest.scenarios[0].original_input = "Different words that should not be displayed.";
    await expect(verifyCaptureExperiment(root, manifest)).rejects.toThrow("ORIGINAL_INPUT_MISMATCH");
  });

  it("rejects incorrect reminder metadata, even if the Markdown is schema-valid", async () => {
    const { root, manifest } = await fixture();
    manifest.scenarios[0].expected_notes[0].due_at = "2026-10-20T09:00:00+02:00";
    await expect(verifyCaptureExperiment(root, manifest)).rejects.toThrow("METADATA_MISMATCH");
  });

  it("rejects an incorrect canonical file path", async () => {
    const { root, manifest } = await fixture();
    const old = manifest.scenarios[0].files[0];
    const wrong = old.replace("2026-10-16", "2026-10-17");
    await writeFile(join(root, wrong), await readFile(join(root, old)));
    await rm(join(root, old));
    manifest.scenarios[0].files[0] = wrong;
    await expect(verifyCaptureExperiment(root, manifest)).rejects.toThrow("INVALID_PATH");
  });

  it("rejects inconsistent capture IDs in a single utterance", async () => {
    const { root, manifest } = await fixture([NOTE_A, NOTE_B]);
    const content = makeMarkdown(NOTE_B, "01K00000000000000000000009");
    await writeFile(join(root, pathFor(NOTE_B)), content);
    await expect(verifyCaptureExperiment(root, manifest)).rejects.toThrow("CAPTURE_GROUP_MISMATCH");
  });

  it("rejects unsafe symlinks instead of opening targets", async () => {
    const { root, manifest } = await fixture();
    await rm(join(root, pathFor(NOTE_A)));
    await symlink("target-absent.md", join(root, pathFor(NOTE_A)));
    await expect(verifyCaptureExperiment(root, manifest)).rejects.toThrow("UNEXPECTED_INBOX_ENTRY");
  });

  it("rejects malformed manifests and never infers expected semantics", async () => {
    const { root, manifest } = await fixture();
    delete manifest.scenarios[0].expected_notes[0].due_at;
    await expect(verifyCaptureExperiment(root, manifest)).rejects.toBeInstanceOf(
      ExperimentValidationError,
    );
  });
});
