import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  ApiTransportError,
  type NoteDetail,
  type ResearchRecord,
} from "@pce/api-client";
import {
  matchingReport,
  noteMetadata,
  orderReports,
  originalLabel,
  researchFailure,
  safeExternalUrl,
  validSourceNoteId,
} from "./detail-model";

const noteId = "11111111-1111-4111-8111-111111111111";
const reportA = "33333333-3333-4333-8333-333333333333";
const reportB = "55555555-5555-4555-8555-555555555555";
const note: NoteDetail = {
  id: noteId,
  title: "Synthetic captured text",
  summary: "Inferred summary",
  body: "Stored body",
  originalInput: "Raw <script>alert(1)</script>\nline 2",
  capturedAt: "2026-10-25T09:00:00+01:00",
  tags: ["derived-tag"],
  metadata: {
    capturedAtRaw: "2026-10-25T09:00:00+01:00",
    source: "mobile_text",
    kind: "memo",
    domains: [],
    projects: ["garden"],
    actionHint: "none",
    reviewRequired: false,
    occurredAt: null,
    dueAt: null,
    timezone: null,
  },
};

const base: ResearchRecord = {
  schemaVersion: 1,
  reportId: reportA,
  seriesId: reportA,
  revision: 1,
  supersedesReportId: null,
  parentNoteId: noteId,
  captureId: "22222222-2222-4222-8222-222222222222",
  title: "Synthetic report",
  question: "What evidence?",
  findings: "Saved facts only.",
  limitations: [],
  researchedAt: "2026-10-25T09:10:00+01:00",
  status: "DRAFT",
  provenance: { agent: "chatgpt", modelId: null },
  pceRetrieval: {
    outcome: "PCE_CONTEXT_UNAVAILABLE",
    queries: ["synthetic"],
    checkedAt: null,
    mode: null,
    degradation: "timeout",
  },
  sources: [],
  claims: [],
  contentHash: "a".repeat(64),
  origin: "api",
  savedAt: "2026-10-25T09:11:00+01:00",
  indexing: "PENDING",
};

describe("immutable note versus derived evidence presentation", () => {
  it("keeps original raw capture distinct from summary and stored note body", () => {
    expect(originalLabel(note)).toBe(note.originalInput);
    expect(noteMetadata(note)).toEqual(
      expect.arrayContaining([
        "Kind: memo",
        "Projects: garden",
        "Effective tags: derived-tag",
      ]),
    );
    expect(originalLabel({ ...note, originalInput: undefined })).toContain(
      "not returned",
    );
    expect(originalLabel({ ...note, originalInput: "" })).toContain("empty");
    expect(originalLabel({ ...note, originalInput: undefined })).not.toContain(
      "Stored body",
    );
    expect(noteMetadata({ ...note, metadata: undefined })).not.toContain(
      "Kind: memo",
    );
  });

  it("keeps persisted version identity and detects substituted/mismatched report", () => {
    const newer = {
      ...base,
      reportId: reportB,
      seriesId: base.seriesId,
      supersedesReportId: base.reportId,
      revision: 2,
      researchedAt: "2026-10-25T10:00:00+01:00",
      status: "COMPLETE" as const,
    };
    expect(orderReports([base, newer]).map((r) => r.reportId)).toEqual([
      reportB,
      reportA,
    ]);
    expect(matchingReport(newer, { ...newer }, noteId)).toBe(true);
    expect(
      matchingReport(newer, { ...newer, contentHash: "b".repeat(64) }, noteId),
    ).toBe(false);
    expect(
      matchingReport(newer, { ...newer, parentNoteId: base.captureId }, noteId),
    ).toBe(false);
    expect(matchingReport(newer, base, noteId)).toBe(false);
  });
});

describe("safe source navigation and research error distinctions", () => {
  it("only opens supported, credential-free web URLs after explicit confirmation in the UI", () => {
    expect(safeExternalUrl("https://example.org/facts?q=1")).toBe(
      "https://example.org/facts?q=1",
    );
    expect(safeExternalUrl("http://example.org")).toBe("http://example.org/");
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,attack",
      "file:///etc/passwd",
      "https://user:password@example.org/",
      "https://example.org\nattack",
      " https://example.org",
      "https://example.org/path here",
      "https://",
      "",
    ])
      expect(safeExternalUrl(url)).toBeNull();
  });

  it("refuses invalid source IDs without treating a link as authorization", () => {
    expect(validSourceNoteId(noteId)).toBe(true);
    expect(validSourceNoteId("../notes/" + noteId)).toBe(false);
  });

  it("distinguishes disabled endpoint, forbidden access and transport failures", () => {
    expect(researchFailure(new ApiRequestError(404, "NOT_FOUND")).kind).toBe(
      "disabled",
    );
    expect(
      researchFailure(new ApiRequestError(403, "FORBIDDEN")),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("cannot read"),
    });
    expect(
      researchFailure(new ApiRequestError(401, "UNAUTHORIZED")),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Sign in"),
    });
    expect(
      researchFailure(new ApiTransportError("NETWORK_ERROR")),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("connection"),
    });
    expect(
      researchFailure(new ApiTransportError("INVALID_RESPONSE")),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("invalid response"),
    });
  });
});
