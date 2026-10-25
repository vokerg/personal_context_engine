import {
  ApiRequestError,
  ApiTransportError,
  isNoteId,
  type NoteDetail,
  type ResearchRecord,
} from "@pce/api-client";

export type ResearchListState =
  | { kind: "loading" }
  | { kind: "ready"; reports: ResearchRecord[] }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

/** Report history is persisted independent of the immutable captured note. */
export function orderReports(reports: readonly ResearchRecord[]): ResearchRecord[] {
  return [...reports].sort(
    (a, b) =>
      b.researchedAt.localeCompare(a.researchedAt) ||
      b.revision - a.revision ||
      a.reportId.localeCompare(b.reportId),
  );
}

export function noteMetadata(note: NoteDetail): string[] {
  const metadata = note.metadata;
  return [
    "Captured: " + note.capturedAt,
    ...(metadata ? [
      "Capture source: " + metadata.source.replace(/_/g, " "),
      "Kind: " + metadata.kind,
      ...(metadata.projects.length ? ["Projects: " + metadata.projects.join(", ")] : []),
      ...(metadata.occurredAt ? ["Occurred: " + metadata.occurredAt] : []),
      ...(metadata.dueAt ? ["Due: " + metadata.dueAt] : []),
    ] : []),
    ...(note.tags?.length ? ["Effective tags: " + note.tags.join(", ")] : []),
  ];
}

/** Never substitute a generated summary/body for an absent original capture. */
export function originalLabel(note: NoteDetail): string {
  return note.originalInput === undefined
    ? "Original input was not returned by this API."
    : note.originalInput.length === 0
      ? "Original input is empty."
      : note.originalInput;
}

/** Restrict the external action to explicit web links, including after decoding. */
export function safeExternalUrl(value: string): string | null {
  if (!value || value.length > 2048 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !!url.hostname && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function validSourceNoteId(id: string): boolean {
  return isNoteId(id);
}

export function matchingReport(
  selected: ResearchRecord,
  fetched: ResearchRecord,
  parentNoteId: string,
): boolean {
  return selected.parentNoteId === parentNoteId &&
    fetched.parentNoteId === parentNoteId &&
    selected.reportId === fetched.reportId &&
    selected.seriesId === fetched.seriesId &&
    selected.revision === fetched.revision &&
    selected.contentHash === fetched.contentHash;
}

export function researchFailure(error: unknown): ResearchListState {
  if (error instanceof ApiRequestError && error.status === 404) {
    return { kind: "disabled" };
  }
  if (error instanceof ApiRequestError) {
    const message = error.status === 401
      ? "Session expired. Sign in again."
      : error.status === 403
        ? "This session cannot read research reports."
        : error.status === 503
          ? "Research is temporarily unavailable."
          : "Unable to read saved research.";
    return { kind: "error", message };
  }
  if (error instanceof ApiTransportError) {
    return {
      kind: "error",
      message: error.code === "TIMEOUT"
        ? "Research request timed out. Retry when connected."
        : error.code === "INVALID_RESPONSE"
          ? "Research API returned an invalid response."
          : "Could not load research. Check your connection.",
    };
  }
  return { kind: "error", message: "Could not load research." };
}
