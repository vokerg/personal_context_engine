import { describe, expect, it } from "vitest";
import { NotePreviewSchema, NoteDetailSchema } from "./index.js";
const preview = {
  id: "01K00000000000000000000001",
  title: "Synthetic",
  summary: "Synthetic summary",
  capturedAt: "2026-10-18T10:00:00Z",
};
describe("optional observed note tags", () => {
  it("accepts legacy DTOs and validated tags without imposing a vocabulary", () => {
    expect(NotePreviewSchema.parse(preview)).toEqual({
      ...preview,
      status: "active",
    });
    expect(
      NotePreviewSchema.parse({ ...preview, tags: ["user-defined-2026"] }).tags,
    ).toEqual(["user-defined-2026"]);
    expect(
      NoteDetailSchema.parse({ ...preview, tags: [], body: "Synthetic" }).tags,
    ).toEqual([]);
  });
  it("rejects malformed tags and unknown private fields", () => {
    for (const tags of [["Bad tag"], ["../x"], [123]])
      expect(NotePreviewSchema.safeParse({ ...preview, tags }).success).toBe(
        false,
      );
    expect(
      NotePreviewSchema.safeParse({ ...preview, ownerSubject: "foreign" })
        .success,
    ).toBe(false);
  });
});
