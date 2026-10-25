import { describe, it, expect } from "vitest";
import { searchIdentifiers } from "./search-lexical.js";
describe("literal search identifiers", () => {
  it("preserves compound identifiers and ignores ordinary dates and hyphenated words", () => {
    expect(searchIdentifiers("AX-912 ax-913 GH-508 Север-8 AX-912")).toEqual([
      "AX-912",
      "ax-913",
      "GH-508",
      "Север-8",
    ]);
    expect(searchIdentifiers("12 March 2026-10-25 crossing-history")).toEqual(
      [],
    );
  });
  it("does not interpret query punctuation as a regular expression", () => {
    expect(searchIdentifiers("AX-912.* (GH-508) '")).toEqual([
      "AX-912",
      "GH-508",
    ]);
  });
});
