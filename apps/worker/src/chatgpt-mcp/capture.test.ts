import { describe, expect, it } from "vitest";
import { parseNoteMarkdown } from "@pce/core";
import { buildChatContextNote, CaptureInputError, type ChatContextInput } from "./capture.js";

const clock = "2026-10-16T19:30:01.000Z";
const request_id = "11111111-2222-4333-8444-555555555555";
const brief: ChatContextInput = {
  request_id,
  mode: "brief",
  title: "A synthetic discussion",
  summary: "We discussed a fictional feature.",
  source_text: "Maybe the imaginary app could support purple themes.\nThis is only a test.",
};

describe("ChatGPT context -> canonical v1 Markdown", () => {
  it("captures a user-selected excerpt as brief without claiming entire chat history", () => {
    const { note, markdown, path } = buildChatContextNote(brief, clock);
    expect(path).toBe("inbox/2026-10-16_" + note.metadata.id + ".md");
    expect(note.metadata.capture_id).not.toBe(note.metadata.id);
    expect(note.metadata.source).toBe("chatgpt_text");
    expect(note.metadata.kind).toBe("memo");
    expect(note.metadata.action_hint).toBe("none");
    expect(note.metadata.review_required).toBe(true);
    expect(note.metadata.tags).toEqual(["chat-context", "brief"]);
    expect(note.metadata.due_at).toBeUndefined();
    expect(note.summary).toBe(brief.summary);
    expect(note.originalInput).toBe(brief.source_text);
    expect(markdown).toContain("NOT the complete chat");
    expect(parseNoteMarkdown(markdown).originalInput).toBe(brief.source_text);
  });

  it("requires confirmation for complete transcripts, preserves Markdown and Cyrillic", () => {
    const full = {
      ...brief,
      mode: "full",
      full_transcript_confirmed: true,
      source_text: "User: Привет\nAssistant: Hello\n## Original input\nUser: bye",
    } satisfies ChatContextInput;
    const result = buildChatContextNote(full, clock);
    expect(result.note.originalInput).toBe(full.source_text);
    expect(result.note.metadata.review_required).toBe(false);
    expect(result.note.metadata.tags).toContain("full");
    expect(result.markdown).toContain("full transcript explicitly confirmed");
    expect(() => buildChatContextNote({ ...full, full_transcript_confirmed: false }, clock)).toThrow(
      new CaptureInputError("TRANSCRIPT_NOT_CONFIRMED"),
    );
    expect(() => buildChatContextNote({ ...brief, full_transcript_confirmed: true }, clock)).toThrow("INVALID_INPUT");
  });

  it("reuses stable note identities for the same request ID, never for a different ID", () => {
    const a = buildChatContextNote(brief, clock);
    const replay = buildChatContextNote(brief, "2026-10-17T00:00:00.000Z");
    const b = buildChatContextNote({ ...brief, request_id: "11111111-2222-4333-8444-555555555556" }, clock);
    expect(a.note.metadata.id).toBe(replay.note.metadata.id);
    expect(a.note.metadata.id).not.toBe(b.note.metadata.id);
    expect(a.note.metadata.capture_id).not.toBe(b.note.metadata.capture_id);
  });

  it("rejects unsafe, partial or oversized inputs before attempting persistence", () => {
    for (const wrong of [
      { ...brief, source_text: "" },
      { ...brief, summary: "" },
      { ...brief, request_id: "../../passwd" },
      { ...brief, title: "bad\nheading" },
      { ...brief, source_text: "x".repeat(700_001) },
      { ...brief, mode: "unknown" },
    ]) {
      expect(() => buildChatContextNote(wrong, clock)).toThrow();
    }
  });
});
