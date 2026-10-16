import { describe, expect, it } from "vitest";
import { parseNoteDeepLink } from "./links.js";

describe("mobile note deep-link navigation", () => {
  const id = "01K00000000000000000000001";

  it("accepts only a canonical note target", () => {
    expect(parseNoteDeepLink("pce://notes/" + id)).toBe(id);
    expect(parseNoteDeepLink("pce://notes/1234")).toBeNull();
    expect(parseNoteDeepLink("pce://users/" + id)).toBeNull();
    expect(parseNoteDeepLink("https://example.com/notes/" + id)).toBeNull();
  });

  it("rejects ambiguous and injected targets", () => {
    for (const value of [
      "pce://notes/" + id + "/extra",
      "pce://notes/" + id + "?token=leaked",
      "pce://notes/" + id + "#secret",
      "pce://notes/%2e%2e/" + id,
      "pce://notes/%2F" + id,
      "pce://secret@notes/" + id,
      "not a url",
    ]) {
      expect(parseNoteDeepLink(value)).toBeNull();
    }
  });
});
