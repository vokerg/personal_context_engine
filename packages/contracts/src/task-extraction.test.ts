import { describe, expect, it } from "vitest";
import { TaskExtractionBatchSchema, taskBatchPath } from "./index.js";
const id = "00000000-0000-4000-8000-000000000001";
const base = {
  schemaVersion: 1,
  batchId: id,
  captureId: id,
  sourceNoteIds: [id],
  classifier: { method: "llm", policyVersion: "tasks-v1", agent: "Synthetic" },
  tasks: [],
};
describe("complete TaskExtractionBatch v1", () => {
  it("supports 0..N actions separately from original Notes", () => {
    expect(
      TaskExtractionBatchSchema.parse({
        ...base,
        zeroTasksReason: "No clear commitment",
      }).tasks,
    ).toEqual([]);
    const task = {
      taskId: id,
      title: "Buy filters",
      sources: [{ noteId: id, captureId: id, evidence: "Buy filters" }],
    };
    expect(
      TaskExtractionBatchSchema.parse({ ...base, tasks: [task] }).tasks,
    ).toHaveLength(1);
    for (const tasks of [
      [{ ...task, sources: [] }],
      [{ ...task, dueAt: "tomorrow" }],
      [task, task],
      [{ ...task, sources: [{ noteId: id, captureId: id }] }],
    ])
      expect(
        TaskExtractionBatchSchema.safeParse({ ...base, tasks }).success,
      ).toBe(false);
    expect(
      TaskExtractionBatchSchema.safeParse({ ...base, ownerSubject: "foreign" })
        .success,
    ).toBe(false);
    expect(
      TaskExtractionBatchSchema.safeParse({ ...base, sourceNoteIds: [id, id] })
        .success,
    ).toBe(false);
    expect(() => taskBatchPath("../README")).toThrow();
  });
});
