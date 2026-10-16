import { TextDecoder, TextEncoder } from "node:util";

export const NOTE_SCHEMA_VERSION = 1 as const;
export const NOTE_SOURCES = [
  "chatgpt_voice",
  "chatgpt_text",
  "mobile_voice",
  "mobile_text",
  "import",
] as const;
export const NOTE_KINDS = [
  "idea",
  "task",
  "memo",
  "thought",
  "decision",
  "reference",
] as const;
export const ACTION_HINTS = [
  "none",
  "consider",
  "remind",
  "review",
  "follow_up",
] as const;

export type NoteSource = (typeof NOTE_SOURCES)[number];
export type NoteKind = (typeof NOTE_KINDS)[number];
export type ActionHint = (typeof ACTION_HINTS)[number];

export interface NoteMetadata {
  schema_version: typeof NOTE_SCHEMA_VERSION;
  id: string;
  capture_id: string;
  captured_at: string;
  source: NoteSource;
  kind: NoteKind;
  domains: string[];
  projects: string[];
  tags: string[];
  action_hint: ActionHint;
  review_required: boolean;
  title: string;
  occurred_at?: string;
  due_at?: string;
  timezone?: string;
  related_note_ids?: string[];
  processing_model?: string;
}

export interface Note {
  metadata: NoteMetadata;
  /** Exact Markdown after the closing frontmatter delimiter. */
  body: string;
  /** Human-readable summary, not interpreted as an executable instruction. */
  summary: string;
  /** Exact text after the Original input heading, including any trailing newlines. */
  originalInput: string;
}

export interface Capture {
  id: string;
  capturedAt: string;
  source: NoteSource;
  timezone?: string;
  notes: Note[];
}

export type NoteValidationCode =
  | "INVALID_ENCODING"
  | "TOO_LARGE"
  | "FRONTMATTER"
  | "UNSAFE_YAML"
  | "INVALID_FIELD"
  | "SCHEMA_VERSION"
  | "INVALID_BODY"
  | "INVALID_PATH"
  | "DUPLICATE_ID"
  | "CAPTURE_MISMATCH";

/** Never embeds note content or the offending field value in messages. */
export class NoteValidationError extends Error {
  constructor(
    public readonly code: NoteValidationCode,
    public readonly field?: string,
  ) {
    super(
      "Note validation failed: " + code + (field ? " (" + field + ")" : ""),
    );
    this.name = "NoteValidationError";
  }
}

const MAX_BYTES = 1024 * 1024;
const MAX_FRONTMATTER_BYTES = 16 * 1024;
const ID_PATTERN =
  /^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARRAY_FIELDS = new Set([
  "domains",
  "projects",
  "tags",
  "related_note_ids",
]);
const REQUIRED_FIELDS = [
  "schema_version",
  "id",
  "capture_id",
  "captured_at",
  "source",
  "kind",
  "domains",
  "projects",
  "tags",
  "action_hint",
  "review_required",
  "title",
] as const;
const OPTIONAL_FIELDS = [
  "occurred_at",
  "due_at",
  "timezone",
  "related_note_ids",
  "processing_model",
] as const;
const ALLOWED_FIELDS = new Set<string>([
  ...REQUIRED_FIELDS,
  ...OPTIONAL_FIELDS,
]);

function fail(code: NoteValidationCode, field?: string): never {
  throw new NoteValidationError(code, field);
}

function parseScalar(value: string, field: string): string {
  if (!value || value !== value.trim()) fail("UNSAFE_YAML", field);
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Reject malformed quoted strings without exposing their contents.
    }
    return fail("UNSAFE_YAML", field);
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) fail("UNSAFE_YAML", field);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  // Explicit, conservative YAML v1 subset: no aliases, tags, block scalars,
  // implicit object/array scalars, comments or ambiguous colon-space pairs.
  if (
    ["!", "&", "*", "|", ">", "{", "}", "[", "]", ",", "#", "%", "@"].some(
      (token) => value.startsWith(token),
    ) ||
    value.startsWith("---") ||
    value.startsWith("...") ||
    /:\s|\s#/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    fail("UNSAFE_YAML", field);
  }
  return value;
}

function parseFrontmatter(source: string): Record<string, unknown> {
  if (new TextEncoder().encode(source).length > MAX_FRONTMATTER_BYTES) {
    fail("TOO_LARGE");
  }
  const result: Record<string, unknown> = Object.create(null);
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === "") continue;
    if (line === undefined || line.includes("\t")) fail("UNSAFE_YAML");
    const match = /^([a-z][a-z0-9_]*):(?: (.*))?$/.exec(line);
    if (!match) fail("UNSAFE_YAML");
    const field = match[1]!;
    if (!ALLOWED_FIELDS.has(field) || Object.hasOwn(result, field)) {
      fail("INVALID_FIELD", field);
    }
    const value = match[2];
    if (ARRAY_FIELDS.has(field)) {
      if (value !== undefined && value !== "") {
        if (value === "[]") {
          result[field] = [];
          continue;
        }
        // JSON-formatted flow arrays are a safe subset of YAML flow arrays.
        try {
          const array: unknown = JSON.parse(value);
          if (
            Array.isArray(array) &&
            array.every((item) => typeof item === "string")
          ) {
            result[field] = array;
            continue;
          }
        } catch {
          // Not an allowed flow array.
        }
        // Harmless LLM variation: explicit string slugs, never general YAML.
        if (
          ["domains", "projects", "tags"].includes(field) &&
          value.startsWith("[") &&
          value.endsWith("]")
        ) {
          const values = value
            .slice(1, -1)
            .split(",")
            .map((item) => item.trim());
          const slugs = values.map((item) => parseScalar(item, field));
          if (slugs.every((item) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item))) {
            result[field] = slugs;
            continue;
          }
        }
        fail("UNSAFE_YAML", field);
      }
      const items: string[] = [];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1]!;
        const itemMatch = /^ {2}- (.*)$/.exec(nextLine);
        if (!itemMatch) break;
        items.push(parseScalar(itemMatch[1]!, field));
        index++;
      }
      if (items.length === 0) fail("INVALID_FIELD", field);
      result[field] = items;
    } else {
      if (value === undefined || value === "") fail("INVALID_FIELD", field);
      if (field === "schema_version") {
        if (!/^\d+$/.test(value)) fail("INVALID_FIELD", field);
        result[field] = Number(value);
      } else if (field === "review_required") {
        if (value !== "true" && value !== "false") {
          fail("INVALID_FIELD", field);
        }
        result[field] = value === "true";
      } else {
        result[field] = parseScalar(value, field);
      }
    }
  }
  return result;
}

function requiredString(
  raw: Record<string, unknown>,
  field: string,
  maxLength = 256,
): string {
  const value = raw[field];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maxLength ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    fail("INVALID_FIELD", field);
  }
  return value;
}

function idValue(value: string, field: string): string {
  if (!ID_PATTERN.test(value)) fail("INVALID_FIELD", field);
  return value;
}

function timestamp(raw: Record<string, unknown>, field: string): string {
  const value = requiredString(raw, field, 40);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) fail("INVALID_FIELD", field);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHours = Number(match[10] ?? 0);
  const offsetMinutes = Number(match[11] ?? 0);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1000 ||
    calendarDay.getUTCFullYear() !== year ||
    calendarDay.getUTCMonth() !== month - 1 ||
    calendarDay.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 14 ||
    offsetMinutes > 59 ||
    (offsetHours === 14 && offsetMinutes !== 0)
  ) {
    fail("INVALID_FIELD", field);
  }
  return value;
}

function slugs(raw: Record<string, unknown>, field: string): string[] {
  const value = raw[field];
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every(
      (entry: unknown) =>
        typeof entry === "string" &&
        entry.length <= 64 &&
        SLUG_PATTERN.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    fail("INVALID_FIELD", field);
  }
  return value as string[];
}

function ids(raw: Record<string, unknown>, field: string): string[] {
  const value = raw[field];
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every(
      (entry: unknown) => typeof entry === "string" && ID_PATTERN.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    fail("INVALID_FIELD", field);
  }
  return value as string[];
}

function oneOf<T extends string>(
  raw: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = requiredString(raw, field);
  if (!allowed.some((entry) => entry === value)) fail("INVALID_FIELD", field);
  return value as T;
}

function optionalString(
  raw: Record<string, unknown>,
  field: string,
): string | undefined {
  return raw[field] === undefined ? undefined : requiredString(raw, field);
}

/** Validates a v1 metadata object without changing intent, tags, or offsets. */
export function validateNoteMetadata(
  raw: Record<string, unknown>,
): NoteMetadata {
  if (raw.schema_version !== NOTE_SCHEMA_VERSION)
    fail("SCHEMA_VERSION", "schema_version");
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(raw, field)) fail("INVALID_FIELD", field);
  }
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(field)) fail("INVALID_FIELD", field);
  }
  const id = idValue(requiredString(raw, "id"), "id");
  const captureId = idValue(requiredString(raw, "capture_id"), "capture_id");
  if (id === captureId) fail("INVALID_FIELD", "capture_id");
  if (typeof raw.review_required !== "boolean") {
    fail("INVALID_FIELD", "review_required");
  }
  const metadata: NoteMetadata = {
    schema_version: NOTE_SCHEMA_VERSION,
    id,
    capture_id: captureId,
    captured_at: timestamp(raw, "captured_at"),
    source: oneOf(raw, "source", NOTE_SOURCES),
    kind: oneOf(raw, "kind", NOTE_KINDS),
    domains: slugs(raw, "domains"),
    projects: slugs(raw, "projects"),
    tags: slugs(raw, "tags"),
    action_hint: oneOf(raw, "action_hint", ACTION_HINTS),
    review_required: raw.review_required,
    title: requiredString(raw, "title", 200),
  };
  if (raw.occurred_at !== undefined) {
    metadata.occurred_at = timestamp(raw, "occurred_at");
  }
  if (raw.due_at !== undefined) {
    metadata.due_at = timestamp(raw, "due_at");
  }
  const timezone = optionalString(raw, "timezone");
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      fail("INVALID_FIELD", "timezone");
    }
    metadata.timezone = timezone;
  }
  if (raw.related_note_ids !== undefined) {
    metadata.related_note_ids = ids(raw, "related_note_ids");
    if (metadata.related_note_ids.includes(id)) {
      fail("INVALID_FIELD", "related_note_ids");
    }
  }
  const processingModel = optionalString(raw, "processing_model");
  if (processingModel !== undefined)
    metadata.processing_model = processingModel;
  return metadata;
}

function parseBody(
  body: string,
  title: string,
): Pick<Note, "summary" | "originalInput"> {
  const titleMatch = /^(?:\r?\n)*# ([^\r\n]+)\r?\n/.exec(body);
  if (!titleMatch || titleMatch[1] !== title) fail("INVALID_BODY", "title");

  // Original input is the terminal section: all subsequent Markdown headings
  // belong to the transcript rather than to the note's structure.
  const headings = [
    ...body.matchAll(
      /^## (Summary|Original input|Details|Context|Open questions)\r?$/gm,
    ),
  ];
  const originalHeading = headings.find(
    (heading) => heading[1] === "Original input",
  );
  if (!originalHeading) fail("INVALID_BODY", "Original input");
  const beforeOriginal = headings.filter(
    (heading) => heading.index! < originalHeading.index!,
  );
  const seen = new Set<string>();
  for (const heading of beforeOriginal) {
    const section = heading[1]!;
    if (seen.has(section)) fail("INVALID_BODY", section);
    seen.add(section);
  }
  const summaryHeading = beforeOriginal.find(
    (heading) => heading[1] === "Summary",
  );
  if (!summaryHeading) fail("INVALID_BODY", "Summary");
  const following = beforeOriginal.find(
    (heading) => heading.index! > summaryHeading.index!,
  );
  const summary = body
    .slice(
      summaryHeading.index! + summaryHeading[0].length,
      following?.index ?? originalHeading.index!,
    )
    .replace(/^\r?\n/, "")
    .trim();
  const originalInput = body
    .slice(originalHeading.index! + originalHeading[0].length)
    .replace(/^\r?\n(?:\r?\n)?/, "");
  if (!summary || !originalInput.trim()) fail("INVALID_BODY");
  return { summary, originalInput };
}

/** UTF-8 decode is fatal: replacement characters must never silently change a capture. */
export function parseNoteMarkdown(input: string | Uint8Array): Note {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_BYTES) fail("TOO_LARGE");
  // Reject a BOM instead of allowing TextDecoder to silently discard bytes.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("INVALID_ENCODING");
  }
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("INVALID_ENCODING");
  }
  if (typeof input === "string" && markdown !== input) fail("INVALID_ENCODING");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) fail("FRONTMATTER");
  const metadata = validateNoteMetadata(parseFrontmatter(match[1]!));
  const body = match[2]!;
  return { metadata, body, ...parseBody(body, metadata.title) };
}

export function safeParseNoteMarkdown(
  input: string | Uint8Array,
):
  | { success: true; note: Note }
  | { success: false; error: NoteValidationError } {
  try {
    return { success: true, note: parseNoteMarkdown(input) };
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return { success: false, error };
    }
    throw error;
  }
}

function encodeScalar(value: string): string {
  return JSON.stringify(value);
}

/** Revalidates metadata and body before writing. No inferred fields are added. */
export function serializeNoteMarkdown(note: Note): string {
  const metadata = validateNoteMetadata(
    note.metadata as unknown as Record<string, unknown>,
  );
  const sections = parseBody(note.body, metadata.title);
  if (
    sections.summary !== note.summary ||
    sections.originalInput !== note.originalInput
  ) {
    fail("INVALID_BODY");
  }
  const lines: string[] = [];
  for (const field of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const value: unknown = metadata[field];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(field + ": []");
      } else {
        lines.push(field + ":");
        for (const item of value)
          lines.push("  - " + encodeScalar(item as string));
      }
    } else if (typeof value === "string") {
      lines.push(field + ": " + encodeScalar(value));
    } else {
      lines.push(field + ": " + String(value));
    }
  }
  return "---\n" + lines.join("\n") + "\n---\n" + note.body;
}

/** Safe canonical locator; note identity never comes from a caller's path. */
export function inboxNotePath(metadata: NoteMetadata): string {
  const valid = validateNoteMetadata(
    metadata as unknown as Record<string, unknown>,
  );
  return "inbox/" + valid.captured_at.slice(0, 10) + "_" + valid.id + ".md";
}

/** Rejects traversal, noncanonical separators, wrong IDs, and wrong dates. */
export function verifyInboxNotePath(
  path: string,
  metadata: NoteMetadata,
): string {
  const canonical = inboxNotePath(metadata);
  if (path !== canonical) fail("INVALID_PATH");
  return canonical;
}

/** One capture may contain several notes; a note ID may occur only once. */
export function groupNotesByCapture(notes: readonly Note[]): Capture[] {
  const groups = new Map<string, Capture>();
  const noteIds = new Set<string>();
  for (const note of notes) {
    const metadata = validateNoteMetadata(
      note.metadata as unknown as Record<string, unknown>,
    );
    const sections = parseBody(note.body, metadata.title);
    if (
      sections.summary !== note.summary ||
      sections.originalInput !== note.originalInput
    ) {
      fail("INVALID_BODY");
    }
    if (noteIds.has(metadata.id)) fail("DUPLICATE_ID", "id");
    noteIds.add(metadata.id);
    let capture = groups.get(metadata.capture_id);
    if (!capture) {
      capture = {
        id: metadata.capture_id,
        capturedAt: metadata.captured_at,
        source: metadata.source,
        ...(metadata.timezone !== undefined
          ? { timezone: metadata.timezone }
          : {}),
        notes: [],
      };
      groups.set(metadata.capture_id, capture);
    } else if (
      capture.capturedAt !== metadata.captured_at ||
      capture.source !== metadata.source ||
      capture.timezone !== metadata.timezone
    ) {
      fail("CAPTURE_MISMATCH", "capture_id");
    }
    capture.notes.push(note);
  }
  return [...groups.values()];
}
