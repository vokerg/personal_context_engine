import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  getNote,
  getResearchForNote,
  getResearchReport,
} from "@pce/api-client";

const noteId = "11111111-1111-4111-8111-111111111111";
const reportId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
const artifact = {
  schemaVersion: 1,
  reportId,
  seriesId: reportId,
  revision: 1,
  supersedesReportId: null,
  parentNoteId: noteId,
  captureId: "22222222-2222-4222-8222-222222222222",
  title: "Fixture research",
  question: "What happened?",
  findings: "Recorded findings",
  limitations: [],
  researchedAt: "2026-10-22T12:00:00Z",
  status: "COMPLETE",
  provenance: { agent: "chatgpt", modelId: null },
  pceRetrieval: {
    outcome: "searched",
    queries: ["fixture"],
    checkedAt: "2026-10-22T11:59:00Z",
    mode: "lexical",
    degradation: "unindexed",
  },
  sources: [
    {
      kind: "pce_note",
      id: "related",
      noteId: sourceId,
      sourceRevision: "fixture-source-rev-1",
      rationale: "Same topic",
    },
    {
      kind: "external",
      id: "website",
      url: "https://example.org/docs",
      title: "Fixture doc",
      checkedAt: "2026-10-22T11:55:00Z",
    },
  ],
  claims: [{
    id: "fact",
    text: "Fixture claim",
    classification: "sourced_fact",
    sourceIds: ["related", "website"],
  }],
  contentHash: "a".repeat(64),
  origin: "api",
  savedAt: "2026-10-22T12:01:00Z",
  indexing: "READY",
};
const original = "Original <img src=x onerror=alert(1)>\nExact line endings\r\n";
const detail = {
  id: noteId,
  title: "Fixture note",
  summary: "Machine summary",
  body: "Normalized body",
  originalInput: original,
  capturedAt: "2026-10-22T12:00:00Z",
  tags: ["project-a"],
};

function mockApi(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const paths: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer " + "A".repeat(64));
    const fallback: Record<string, unknown> = {
      ["/api/v1/notes/" + noteId]: detail,
      ["/api/v1/notes/" + noteId + "/research"]: { reports: [artifact], imports: [] },
      ["/api/v1/research/reports/" + reportId]: artifact,
    };
    const response = overrides[path];
    return new Response(JSON.stringify(response ? response.body : fallback[path]), {
      status: response?.status ?? (path in fallback ? 200 : 404),
      headers: { "Content-Type": "application/json" },
    });
  };
  const options = {
    baseUrl: "https://pce.example",
    getAccessToken: () => "A".repeat(64),
    request,
  };
  return { options, paths };
}

describe("native note/research API read contract", () => {
  it("fetches original note and independently stored research history with real validated provenance", async () => {
    const { options, paths } = mockApi();
    const note = await getNote(options, noteId);
    expect(note.originalInput).toBe(original);
    expect(note.summary).toBe("Machine summary");
    const history = await getResearchForNote(options, noteId);
    expect(history.reports).toHaveLength(1);
    expect(history.reports[0]?.status).toBe("COMPLETE");
    expect(history.reports[0]?.sources[0]).toMatchObject({
      kind: "pce_note",
      noteId: sourceId,
      sourceRevision: "fixture-source-rev-1",
    });
    const revision = await getResearchReport(options, reportId);
    expect(revision.reportId).toBe(reportId);
    expect(revision.claims[0]?.sourceIds).toEqual(["related", "website"]);
    expect(paths).toEqual([
      "/api/v1/notes/" + noteId,
      "/api/v1/notes/" + noteId + "/research",
      "/api/v1/research/reports/" + reportId,
    ]);
  });
  it("preserves unauthorized/not-found distinctions without yielding source data", async () => {
    const path = "/api/v1/notes/" + noteId;
    for (const status of [401, 403, 404, 503]) {
      const { options } = mockApi({
        [path]: { status, body: { error: { code: status === 401 ? "UNAUTHORIZED" : "NOT_FOUND", message: "Not exposed" } } },
      });
      await expect(getNote(options, noteId)).rejects.toMatchObject({ status });
    }
  });
  it("does not silently accept malformed report or forged source history", async () => {
    const url = "/api/v1/notes/" + noteId + "/research";
    const { options } = mockApi({
      [url]: { status: 200, body: { reports: [{ ...artifact, sources: [{
        kind: "external", id: "website", url: "javascript:alert(1)", title: null,
        checkedAt: artifact.researchedAt,
      }] }] } },
    });
    await expect(getResearchForNote(options, noteId)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
