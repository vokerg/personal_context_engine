import { describe, expect, it } from "vitest";
import {
  CHUNKER_VERSION,
  CHUNK_SIZE_CODEPOINTS,
  MAX_CHUNKS_PER_NOTE,
  ChunkLimitError,
  chunkNoteText,
} from "./chunks.js";

const noteId = "01K00000000000000000000001";

describe("deterministic provider-independent chunking", () => {
  it("normalizes NFC and LF, preserves section provenance, and is repeatable", () => {
    const source = {
      noteId,
      originalInput: "Cafe\u0301\r\nnext",
      summary: "Summary",
      body: "",
    };
    const chunks = chunkNoteText(source);
    expect(chunks.map((chunk) => chunk.section)).toEqual([
      "original",
      "summary",
    ]);
    expect(chunks[0]?.text).toBe("Café\nnext");
    expect(chunks[0]).toMatchObject({
      startOffset: 0,
      endOffset: 9,
      ordinal: 0,
    });
    expect(chunkNoteText(source)).toEqual(chunks);
    expect(CHUNKER_VERSION).toContain("v1");
  });

  it("splits on code-point boundaries, retaining exact offsets and no lost text", () => {
    const originalInput = "😀".repeat(CHUNK_SIZE_CODEPOINTS + 1);
    const chunks = chunkNoteText({
      noteId,
      originalInput,
      summary: "",
      body: "",
    });
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => [chunk.startOffset, chunk.endOffset])).toEqual(
      [
        [0, CHUNK_SIZE_CODEPOINTS],
        [CHUNK_SIZE_CODEPOINTS, CHUNK_SIZE_CODEPOINTS + 1],
      ],
    );
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(originalInput);
  });

  it("keeps IDs for identical text but changes IDs and hashes when text changes", () => {
    const base = { noteId, originalInput: "before", summary: "", body: "" };
    const first = chunkNoteText(base)[0]!;
    const second = chunkNoteText({ ...base, originalInput: "after" })[0]!;
    expect(first.id).not.toBe(second.id);
    expect(first.contentHash).not.toBe(second.contentHash);
    expect(chunkNoteText(base)[0]?.id).toBe(first.id);
    expect(chunkNoteText({ ...base, noteId: "another" })[0]?.id).not.toBe(
      first.id,
    );
  });

  it("rejects excess work without emitting a partial set", () => {
    expect(() =>
      chunkNoteText({
        noteId,
        originalInput: "x".repeat(
          CHUNK_SIZE_CODEPOINTS * (MAX_CHUNKS_PER_NOTE + 1),
        ),
        summary: "",
        body: "",
      }),
    ).toThrow(ChunkLimitError);
  });
});
