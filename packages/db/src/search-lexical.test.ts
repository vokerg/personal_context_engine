import { describe, it, expect } from "vitest";
import { searchIdentifiers, keywordLookup } from "./search-lexical.js";
describe("literal search identifiers", () => {
  it("restricts title anchoring to single tokens", () => {
    expect(keywordLookup("чай")).toBe(true);
    expect(keywordLookup("AX-912")).toBe(true);
    expect(keywordLookup("How do I make tea?")).toBe(false);
    expect(keywordLookup("cash flow")).toBe(false);
  });
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
