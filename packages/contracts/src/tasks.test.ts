import { describe, expect, it } from "vitest";
import {
  TaskCreateSchema,
  TaskListQuerySchema,
  TaskMutationSchema,
} from "./index.js";
const id = "00000000-0000-4000-8000-000000000001";
describe("independent Task contracts", () => {
  it("bounds input and rejects owner, dates, reminder instructions and duplicate sources", () => {
    const input = { taskId: id, title: "Buy synthetic filters" };
    expect(TaskCreateSchema.parse(input).sources).toEqual([]);
    for (const extra of [
      { owner: "foreign" },
      { dueAt: "tomorrow" },
      { reminder: true },
      { title: " " },
      { title: "a".repeat(201) },
    ])
      expect(TaskCreateSchema.safeParse({ ...input, ...extra }).success).toBe(
        false,
      );
    const source = { noteId: id, captureId: id };
    expect(
      TaskCreateSchema.safeParse({ ...input, sources: [source, source] })
        .success,
    ).toBe(false);
    expect(TaskListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(TaskListQuerySchema.safeParse({ owner: "foreign" }).success).toBe(
      false,
    );
    expect(
      TaskMutationSchema.safeParse({ status: "COMPLETED", expectedRevision: 1 })
        .success,
    ).toBe(false);
  });
});
