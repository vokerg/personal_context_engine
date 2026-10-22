import { describe, expect, it } from "vitest";
import {
  ResearchArtifactSchema,
  ResearchSaveRequestSchema,
} from "./research.js";
const parentNoteId = "11111111-1111-4111-8111-111111111111";
const captureId = "22222222-2222-4222-8222-222222222222";
const reportId = "33333333-3333-4333-8333-333333333333";
export const validResearch = () => ({
  schemaVersion: 1,
  reportId,
  seriesId: reportId,
  revision: 1,
  supersedesReportId: null,
  parentNoteId,
  captureId,
  title: "Synthetic topic",
  question: "What is supported?",
  findings: "Synthetic evidence only.",
  limitations: ["This is a fixture."],
  researchedAt: "2026-10-22T12:00:00Z",
  status: "COMPLETE",
  provenance: { agent: "chatgpt", modelId: null },
  pceRetrieval: {
    outcome: "searched",
    queries: ["topic"],
    checkedAt: "2026-10-22T11:55:00Z",
    mode: "hybrid",
    degradation: null,
  },
  sources: [
    {
      id: "prior-note",
      kind: "pce_note",
      noteId: "44444444-4444-4444-8444-444444444444",
      sourceRevision: "fixture-revision",
      rationale: "Related project context",
    },
    {
      id: "public-page",
      kind: "external",
      url: "https://example.org/facts",
      title: "Synthetic facts",
      checkedAt: "2026-10-22T11:58:00Z",
    },
  ],
  claims: [
    {
      id: "finding-one",
      text: "Grounded synthetic result",
      classification: "sourced_fact",
      sourceIds: ["public-page", "prior-note"],
    },
  ],
});
describe("research interchange v1", () => {
  it("accepts separately versioned, attributed research and rejects extra frontmatter-like data", () => {
    expect(
      ResearchSaveRequestSchema.parse({ artifact: validResearch() }).artifact
        .reportId,
    ).toBe(reportId);
    expect(
      ResearchArtifactSchema.safeParse({
        ...validResearch(),
        ownerSubject: "forged",
      }).success,
    ).toBe(false);
    expect(
      ResearchArtifactSchema.safeParse({
        ...validResearch(),
        status: "FINISHED",
      }).success,
    ).toBe(false);
  });
  it("does not claim context-complete results when PCE retrieval is unavailable", () => {
    const draft = {
      ...validResearch(),
      status: "DRAFT",
      pceRetrieval: {
        outcome: "PCE_CONTEXT_UNAVAILABLE",
        queries: ["topic"],
        checkedAt: null,
        mode: null,
        degradation: "timeout",
      },
      sources: [],
    };
    expect(ResearchArtifactSchema.safeParse(draft).success).toBe(true);
    expect(
      ResearchArtifactSchema.safeParse({ ...draft, status: "COMPLETE" })
        .success,
    ).toBe(false);
    expect(
      ResearchArtifactSchema.safeParse({
        ...validResearch(),
        pceRetrieval: {
          outcome: "no_related_notes_found",
          queries: ["topic"],
          checkedAt: "2026-10-22T12:00:00Z",
          mode: "lexical",
          degradation: null,
        },
      }).success,
    ).toBe(false);
  });
  it("enforces evidence IDs, safe URLs and immutable revision lineage", () => {
    const sample = validResearch();
    expect(
      ResearchArtifactSchema.safeParse({
        ...sample,
        claims: [{ ...sample.claims[0], sourceIds: ["missing"] }],
      }).success,
    ).toBe(false);
    expect(
      ResearchArtifactSchema.safeParse({
        ...sample,
        sources: [
          {
            id: "public-page",
            kind: "external",
            url: "javascript:alert(1)",
            title: null,
            checkedAt: sample.researchedAt,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ResearchArtifactSchema.safeParse({ ...sample, revision: 2 }).success,
    ).toBe(false);
    expect(
      ResearchArtifactSchema.safeParse({
        ...sample,
        parentNoteId: sample.reportId,
      }).success,
    ).toBe(false);
  });
  it("bounds payload size", () => {
    expect(
      ResearchSaveRequestSchema.safeParse({
        artifact: { ...validResearch(), findings: "x".repeat(160000) },
      }).success,
    ).toBe(false);
  });
});
