import { describe, expect, it } from "vitest";
import { NotesQuerySchema, TagFacetsResponseSchema } from "./index.js";

describe("tag and note-filter contracts", () => {
  it("accepts observed slug/count rows and rejects unsafe results", () => {
    expect(TagFacetsResponseSchema.parse({
      tags: [{ slug: "sample-2026", count: 2 }], truncated: false,
    }).tags[0]?.count).toBe(2);
    for (const invalid of [
      { tags: [{ slug: "CAPS", count: 1 }], truncated: false },
      { tags: [{ slug: "sample", count: 0 }], truncated: false },
      { tags: [{ slug: "sample", count: 1, original: "private" }], truncated: false },
      { tags: Array.from({ length: 201 }, (_, i) => ({
        slug: "tag-" + i, count: 1,
      })), truncated: true },
    ]) {
      expect(TagFacetsResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("checks days, ranges, kinds, slugs and extraneous keys", () => {
    expect(NotesQuerySchema.parse({ tag: "first-tag", from: "2026-10-01" }))
      .toEqual({ tag: "first-tag", from: "2026-10-01" });
    for (const invalid of [
      { tag: "Bad" }, { project: "with spaces" }, { kind: "urgent" },
      { from: "2026-02-30" }, { to: "2026-13-01" },
      { from: "2026-10-18", to: "2026-10-17" }, { owner: "alice" },
    ]) {
      expect(NotesQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });
});
