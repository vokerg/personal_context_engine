import { test, expect } from "vitest";
import { reconcileSnapshot } from "./local-ingestion.mjs";
import { ProjectionConflictError } from "@pce/db";
import { serializeNoteMarkdown } from "@pce/core";
import { randomUUID } from "node:crypto";

function capture() {
  const id = randomUUID();
  return {
    id,
    markdown: serializeNoteMarkdown({
      metadata: {
        schema_version: 1,
        id,
        capture_id: randomUUID(),
        captured_at: "2026-10-18T10:00:00Z",
        source: "import",
        kind: "memo",
        domains: [],
        projects: [],
        tags: [],
        action_hint: "none",
        review_required: false,
        title: "Synthetic",
      },
      body: "\n# Synthetic\n\n## Summary\n\nSynthetic summary.\n\n## Original input\n\nSynthetic input.\n",
      summary: "Synthetic summary.",
      originalInput: "Synthetic input.\n",
    }),
  };
}

test("changed/foreign notes never overwrite originals or starve independent captures", async () => {
  const changed = capture(),
    fresh = capture();
  const missing = randomUUID();
  const calls = [];
  const result = await reconcileSnapshot({
    snapshot: { captures: [changed, fresh] },
    knownNoteIds: [changed.id, missing],
    project: async (input) => {
      calls.push(input.id);
      if (input.id === changed.id)
        throw new ProjectionConflictError("REVISION_CONFLICT");
      return { noteId: input.id, result: "created" };
    },
  });
  expect(calls).toEqual([changed.id, fresh.id]);
  expect(result.ids).toEqual([fresh.id]);
  expect(result.conflicts).toBe(1);
  expect(result.missing).toBe(1);
  expect(result.knownNoteIds).toEqual([changed.id, fresh.id, missing].sort());
});

test("a rename retaining the note ID is observed; deleted originals stay known across restarts", async () => {
  const note = capture(),
    missing = randomUUID();
  const run = (knownNoteIds) =>
    reconcileSnapshot({
      snapshot: { captures: [note] },
      knownNoteIds,
      project: async () => ({ noteId: note.id }),
    });
  const first = await run([note.id, missing]);
  expect(first.missing).toBe(1);
  expect((await run(first.knownNoteIds)).missing).toBe(1);
});

test("transient DB/provider failures abort reconciliation without a success checkpoint", async () => {
  await expect(
    reconcileSnapshot({
      snapshot: { captures: [capture()] },
      knownNoteIds: [],
      project: async () => {
        throw new Error("Synthetic outage");
      },
    }),
  ).rejects.toThrow("Synthetic outage");
});
