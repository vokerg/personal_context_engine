import { createHash } from "node:crypto";

export const CHUNKER_VERSION = "unicode-nfc-lf-2048-v1";
export const CHUNK_SIZE_CODEPOINTS = 2048;
export const MAX_CHUNKS_PER_NOTE = 512;

export type ChunkSection = "original" | "summary" | "body";

export interface ChunkSource {
  noteId: string;
  originalInput: string;
  summary: string;
  body: string;
}

export interface NoteChunkDraft {
  id: string;
  section: ChunkSection;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  contentHash: string;
  text: string;
}

export class ChunkLimitError extends Error {
  constructor() {
    super("Note exceeds deterministic chunk limit");
    this.name = "ChunkLimitError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Pure, provider-independent chunker. Offsets count Unicode code points in
 * each NFC-normalized, LF-separated section, NOT bytes or UTF-16 code units.
 * Chunks never split a surrogate pair. No original text is logged or sent.
 * Oversize notes fail atomically rather than silently dropping a suffix.
 */
export function chunkNoteText(input: ChunkSource): NoteChunkDraft[] {
  const chunks: NoteChunkDraft[] = [];
  const sections: readonly [ChunkSection, string][] = [
    ["original", input.originalInput],
    ["summary", input.summary],
    ["body", input.body],
  ];

  for (const [section, raw] of sections) {
    const characters = Array.from(raw.replace(/\r\n?/g, "\n").normalize("NFC"));
    const count = Math.ceil(characters.length / CHUNK_SIZE_CODEPOINTS);
    if (chunks.length + count > MAX_CHUNKS_PER_NOTE) {
      throw new ChunkLimitError();
    }
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const startOffset = ordinal * CHUNK_SIZE_CODEPOINTS;
      const endOffset = Math.min(
        startOffset + CHUNK_SIZE_CODEPOINTS,
        characters.length,
      );
      const text = characters.slice(startOffset, endOffset).join("");
      const id = sha256(
        ["pce-chunk", CHUNKER_VERSION, input.noteId, section, ordinal].join(
          "\0",
        ),
      );
      chunks.push({
        id,
        section,
        ordinal,
        startOffset,
        endOffset,
        contentHash: sha256(text),
        text,
      });
    }
  }
  return chunks;
}
