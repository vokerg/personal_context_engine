import { createHash } from "node:crypto";
import {
  inboxNotePath,
  parseNoteMarkdown,
  serializeNoteMarkdown,
  type Note,
  type NoteMetadata,
} from "@pce/core";

export type CaptureMode = "brief" | "full";

export interface ChatContextInput {
  /** Stable UUID generated once for a user-approved save; repeat it on retries. */
  request_id: string;
  mode: CaptureMode;
  title: string;
  summary: string;
  /** Literal user-selected excerpt for brief, actual transcript for full. */
  source_text: string;
  /** Must be explicitly affirmed by user for full mode; never inferred. */
  full_transcript_confirmed?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CaptureInputError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "TRANSCRIPT_NOT_CONFIRMED") {
    super(code);
  }
}

function uuidFromKey(key: string, namespace: string): string {
  const hex = createHash("sha256").update(namespace).update(":").update(key).digest("hex").slice(0, 32);
  // UUID version 5-shaped stable ID (SHA-256-derived; not RFC 4122 UUIDv5).
  const value = hex.slice(0, 12) + "5" + hex.slice(13, 16) + "8" + hex.slice(17);
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join("-");
}

function textField(value: unknown, max: number): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= max &&
    !value.includes("\u0000");
}

/** Pure, deterministic except for the injected server-side capture clock. */
export function buildChatContextNote(
  raw: unknown,
  capturedAt: string,
): { path: string; markdown: string; note: Note } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CaptureInputError("INVALID_INPUT");
  const input = raw as Partial<ChatContextInput>;
  if (
    typeof input.request_id !== "string" || !UUID.test(input.request_id) ||
    (input.mode !== "brief" && input.mode !== "full") ||
    !textField(input.title, 200) || input.title.includes("\n") || input.title !== input.title.trim() ||
    !textField(input.summary, 20_000) ||
    !textField(input.source_text, 700_000) ||
    input.source_text.includes("\r") && !input.source_text.includes("\n")
  ) throw new CaptureInputError("INVALID_INPUT");

  if (input.mode === "full" && input.full_transcript_confirmed !== true) {
    throw new CaptureInputError("TRANSCRIPT_NOT_CONFIRMED");
  }
  if (input.mode === "brief" && input.full_transcript_confirmed === true) {
    throw new CaptureInputError("INVALID_INPUT");
  }
  // No caller-supplied timestamp: use a trusted server clock and always store UTC.
  const metadata: NoteMetadata = {
    schema_version: 1,
    id: uuidFromKey(input.request_id, "pce-chat-context-note"),
    capture_id: uuidFromKey(input.request_id, "pce-chat-context-capture"),
    captured_at: capturedAt,
    source: "chatgpt_text",
    kind: "memo",
    domains: [],
    projects: [],
    tags: ["chat-context", input.mode],
    action_hint: "none",
    review_required: input.mode === "brief",
    title: input.title,
  };
  const body = "\n# " + input.title +
    "\n\n## Summary\n\n" + input.summary +
    "\n\n## Context\n\nCapture mode: " + input.mode +
    (input.mode === "brief"
      ? "\nCoverage: selected verbatim excerpt, NOT the complete chat."
      : "\nCoverage: full transcript explicitly confirmed by the user.") +
    "\n\n## Original input\n\n" + input.source_text;
  // Reparse the serialized artifact through the canonical strict v1 validator.
  const proposed: Note = {
    metadata,
    body,
    summary: input.summary.trim(),
    originalInput: input.source_text,
  };
  const markdown = serializeNoteMarkdown(proposed);
  const note = parseNoteMarkdown(markdown);
  return { path: inboxNotePath(note.metadata), markdown, note };
}
