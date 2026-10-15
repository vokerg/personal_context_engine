import { describe, expect, it } from "vitest";
import {
  groupNotesByCapture,
  inboxNotePath,
  NoteValidationError,
  parseNoteMarkdown,
  safeParseNoteMarkdown,
  serializeNoteMarkdown,
  verifyInboxNotePath,
} from "./capture.js";

const CAPTURE_ID = "01K00000000000000000000000";
const NOTE_ID = "01K00000000000000000000001";
const NOTE_ID_2 = "01K00000000000000000000002";

// All fixtures are synthetic. The source utterances are not user data.
const idea = [
  "---",
  "schema_version: 1",
  "id: " + NOTE_ID,
  "capture_id: " + CAPTURE_ID,
  "captured_at: 2026-10-15T08:30:00+02:00",
  "source: chatgpt_text",
  "kind: idea",
  "domains:",
  "  - development",
  "projects: []",
  "tags:",
  "  - training",
  "action_hint: consider",
  "review_required: false",
  "title: Sample training idea",
  "timezone: Europe/Prague",
  "---",
  "",
  "# Sample training idea",
  "",
  "## Summary",
  "",
  "Consider a new learning exercise in the future.",
  "",
  "## Original input",
  "",
  "Maybe make a training exercise someday; this is not urgent.",
  "",
].join("\n");

function changed(source: string, before: string, after: string): string {
  const result = source.replace(before, after);
  expect(result).not.toBe(source);
  return result;
}

function invalid(source: string, code: NoteValidationError["code"]): void {
  const result = safeParseNoteMarkdown(source);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toBeInstanceOf(NoteValidationError);
    expect(result.error.code).toBe(code);
    expect(result.error.message).not.toContain("Maybe make a training");
  }
}

describe("version 1 Markdown capture contract", () => {
  it("round-trips synthetic idea verbatim, including source offset and original text", () => {
    const note = parseNoteMarkdown(idea);
    const serialized = serializeNoteMarkdown(note);
    expect(parseNoteMarkdown(serialized)).toEqual(note);
    expect(serialized).toContain('"2026-10-15T08:30:00+02:00"');
    expect(note.originalInput).toBe(
      "Maybe make a training exercise someday; this is not urgent.\n",
    );
    expect(note.metadata.timezone).toBe("Europe/Prague");
    expect(note.metadata.due_at).toBeUndefined();
  });

  it("keeps an explicit task distinct from inferred reminders and dates", () => {
    const task = changed(
      changed(
        changed(idea, "kind: idea", "kind: task"),
        "action_hint: consider",
        "action_hint: follow_up",
      ),
      "review_required: false",
      "review_required: true",
    );
    const note = parseNoteMarkdown(task);
    expect(note.metadata.kind).toBe("task");
    expect(note.metadata.review_required).toBe(true);
    expect(note.metadata.due_at).toBeUndefined();
    expect(parseNoteMarkdown(serializeNoteMarkdown(note))).toEqual(note);
  });

  it("keeps ambiguous reminder language unscheduled for review", () => {
    const reminder = changed(
      changed(idea, "action_hint: consider", "action_hint: remind"),
      "review_required: false",
      "review_required: true",
    );
    const note = parseNoteMarkdown(reminder);
    expect(note.metadata.action_hint).toBe("remind");
    expect(note.metadata.due_at).toBeUndefined();
  });

  it("retains Unicode, multiple languages and exact CRLF body formatting", () => {
    const localized = idea
      .replaceAll("Sample training idea", "České poznámky")
      .replace(
        "Maybe make a training exercise someday; this is not urgent.",
        "Možná později něco zkusit. 日本語でも記録する。\n# not a structural heading",
      )
      .replace(/\n/g, "\r\n");
    const note = parseNoteMarkdown(new TextEncoder().encode(localized));
    expect(note.originalInput).toContain("日本語でも記録する。");
    expect(note.originalInput).toContain("\r\n# not a structural heading");
    expect(parseNoteMarkdown(serializeNoteMarkdown(note))).toEqual(note);
  });

  it("links several unique notes to the same capture without deduplicating meaning", () => {
    const first = parseNoteMarkdown(idea);
    const second = parseNoteMarkdown(
      changed(idea, "id: " + NOTE_ID, "id: " + NOTE_ID_2),
    );
    const groups = groupNotesByCapture([first, second]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe(CAPTURE_ID);
    expect(groups[0]?.notes.map((note) => note.metadata.id)).toEqual([
      NOTE_ID,
      NOTE_ID_2,
    ]);
  });

  it("rejects duplicate IDs and capture source/timestamp mismatches", () => {
    const first = parseNoteMarkdown(idea);
    expect(() => groupNotesByCapture([first, first])).toThrow(
      NoteValidationError,
    );
    const second = parseNoteMarkdown(
      changed(
        changed(idea, "id: " + NOTE_ID, "id: " + NOTE_ID_2),
        "source: chatgpt_text",
        "source: import",
      ),
    );
    expect(() => groupNotesByCapture([first, second])).toThrowError(
      "CAPTURE_MISMATCH",
    );
  });

  it("refuses capture grouping when projected original text or summary diverges", () => {
    const note = parseNoteMarkdown(idea);
    expect(() =>
      groupNotesByCapture([{ ...note, originalInput: "tampered" }]),
    ).toThrowError("INVALID_BODY");
    expect(() =>
      groupNotesByCapture([{ ...note, summary: "tampered" }]),
    ).toThrowError("INVALID_BODY");
  });

  it("constructs and verifies a date-partitioned, canonical inbox path", () => {
    const note = parseNoteMarkdown(idea);
    const canonical = "inbox/2026-10-15_" + NOTE_ID + ".md";
    expect(inboxNotePath(note.metadata)).toBe(canonical);
    expect(verifyInboxNotePath(canonical, note.metadata)).toBe(canonical);
    for (const candidate of [
      "../" + canonical,
      "inbox/../" + canonical,
      canonical.replaceAll("/", "\\"),
      canonical.replace(NOTE_ID, CAPTURE_ID),
      canonical.replace("2026-10-15", "2026-10-16"),
    ]) {
      expect(() => verifyInboxNotePath(candidate, note.metadata)).toThrowError(
        "INVALID_PATH",
      );
    }
    expect(() =>
      inboxNotePath({ ...note.metadata, id: "../../secrets" }),
    ).toThrowError("INVALID_FIELD");
  });

  it("accepts valid UUID identity and an explicit offset-bearing due time", () => {
    const source = idea
      .replace("id: " + NOTE_ID, "id: 550e8400-e29b-41d4-a716-446655440000")
      .replace("timezone: Europe/Prague", "due_at: 2026-10-16T14:15:00+05:30");
    const note = parseNoteMarkdown(source);
    expect(note.metadata.due_at).toBe("2026-10-16T14:15:00+05:30");
    expect(parseNoteMarkdown(serializeNoteMarkdown(note))).toEqual(note);
  });

  it("rejects unsupported versions, unsafe YAML, aliases and duplicate keys", () => {
    invalid(
      changed(idea, "schema_version: 1", "schema_version: 2"),
      "SCHEMA_VERSION",
    );
    invalid(
      changed(idea, "title: Sample", "title: &alias Sample"),
      "UNSAFE_YAML",
    );
    invalid(
      changed(idea, "tags:\n  - training", "tags:\n  - *alias"),
      "UNSAFE_YAML",
    );
    invalid(
      changed(idea, "kind: idea", "kind: idea\nkind: task"),
      "INVALID_FIELD",
    );
    invalid(
      changed(idea, "projects: []", "projects: { key: value }"),
      "UNSAFE_YAML",
    );
    invalid(
      changed(idea, "tags:\n  - training", "tags:\n  -"),
      "INVALID_FIELD",
    );
    invalid(
      changed(idea, "title: Sample", "title: >\n  Sample"),
      "UNSAFE_YAML",
    );
  });

  it("rejects invalid IDs, enum fields, metadata and unsafe or duplicate labels", () => {
    invalid(changed(idea, "id: " + NOTE_ID, "id: ../forged"), "INVALID_FIELD");
    invalid(
      changed(idea, "capture_id: " + CAPTURE_ID, "capture_id: " + NOTE_ID),
      "INVALID_FIELD",
    );
    invalid(changed(idea, "kind: idea", "kind: dangerous"), "INVALID_FIELD");
    invalid(
      changed(idea, "tags:\n  - training", "tags:\n  - training\n  - training"),
      "INVALID_FIELD",
    );
    invalid(changed(idea, "  - training", "  - UpperCase"), "INVALID_FIELD");
    invalid(
      changed(idea, "review_required: false", "review_required: yes"),
      "INVALID_FIELD",
    );
    invalid(
      changed(idea, "timezone: Europe/Prague", "timezone: Planet/Never"),
      "INVALID_FIELD",
    );
    invalid(
      changed(idea, "source: chatgpt_text", "source: github_private"),
      "INVALID_FIELD",
    );
  });

  it("rejects malformed dates, missing offset, bad calendar values and impossible timezone offsets", () => {
    for (const date of [
      "2026-02-30T08:30:00+02:00",
      "2026-10-15T08:30:00",
      "2026-10-15T25:30:00+02:00",
      "2026-10-15T08:30:60+02:00",
      "2026-10-15T08:30:00+14:30",
    ]) {
      invalid(
        changed(idea, "2026-10-15T08:30:00+02:00", date),
        "INVALID_FIELD",
      );
    }
  });

  it("rejects missing or duplicated mandatory headings and title divergence", () => {
    invalid(changed(idea, "## Summary", "## Overview"), "INVALID_BODY");
    invalid(
      changed(idea, "## Original input", "## Transcript"),
      "INVALID_BODY",
    );
    invalid(
      changed(idea, "# Sample training idea", "# Different title"),
      "INVALID_BODY",
    );
    invalid(
      changed(idea, "## Summary", "## Summary\n\n## Summary"),
      "INVALID_BODY",
    );
  });

  it("rejects non-UTF8, excess size, invalid delimiters and single-surrogate input", () => {
    expect(() => parseNoteMarkdown(Uint8Array.from([0xff, 0xfe]))).toThrowError(
      "INVALID_ENCODING",
    );
    expect(() => parseNoteMarkdown(idea + "\ud800")).toThrowError(
      "INVALID_ENCODING",
    );
    expect(() =>
      parseNoteMarkdown(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(idea)])),
    ).toThrowError("INVALID_ENCODING");
    expect(() => parseNoteMarkdown("missing delimiters")).toThrowError(
      "FRONTMATTER",
    );
    expect(() =>
      parseNoteMarkdown(idea + "a".repeat(1024 * 1024)),
    ).toThrowError("TOO_LARGE");
  });

  it("fails serialization if the caller changes an original transcript independently of its body", () => {
    const parsed = parseNoteMarkdown(idea);
    expect(() =>
      serializeNoteMarkdown({ ...parsed, originalInput: "rewritten" }),
    ).toThrowError("INVALID_BODY");
  });
});
