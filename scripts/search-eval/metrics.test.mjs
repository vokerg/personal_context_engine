import { describe, it, expect } from "vitest";
import { measure, summarize } from "./metrics.mjs";
import { syntheticBenchmark } from "./fixtures.mjs";
describe("retrieval evaluation metrics", () => {
  it("uses fixed K precision, graded nDCG and full-list MRR", () => {
    const q = { relevance: { a: 3, b: 1 } };
    const r = measure(q, ["x", "b", "a"], 2);
    expect(r.precision).toBe(0.5);
    expect(r.recall).toBe(0.5);
    expect(r.reciprocalRank).toBe(0.5);
    expect(r.ndcg).toBeCloseTo(1 / Math.log2(3) / (7 + 1 / Math.log2(3)), 10);
    expect(measure(q, ["a"], 5).precision).toBe(0.2);
  });
  it("scores no-answer false positives separately from undefined recall and nDCG", () => {
    expect(measure({ relevance: {} }, [], 5)).toMatchObject({
      recall: null,
      ndcg: null,
      falsePositive: 0,
    });
    expect(measure({ relevance: {} }, ["x"], 5).falsePositive).toBe(1);
    expect(() => measure({ relevance: {} }, ["x", "x"])).toThrow("Duplicate");
  });
  it("excludes no-answer queries from macro recall while retaining them in precision", () => {
    const s = summarize(
      [
        { id: "1", category: "exact", relevance: { a: 3 } },
        { id: "2", category: "no_answer", relevance: {} },
      ],
      { 1: ["a"], 2: ["x"] },
    );
    expect(s.overall.recall).toBe(1);
    expect(s.overall.precision).toBe(0.1);
    expect(s.overall.falsePositive).toBe(1);
  });
  it("keeps query families in one split with independent judged document IDs", () => {
    const b = syntheticBenchmark;
    const ids = new Set(b.documents.map((d) => d.id));
    expect(b.queries).toHaveLength(96);
    for (const q of b.queries)
      for (const id of Object.keys(q.relevance)) expect(ids.has(id)).toBe(true);
    for (const family of new Set(b.queries.map((q) => q.family)))
      expect(
        new Set(
          b.queries.filter((q) => q.family === family).map((q) => q.split),
        ).size,
      ).toBe(1);
  });
});
