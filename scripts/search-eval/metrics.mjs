/** Binary P/R/MRR use grade >0; nDCG uses exponential graded gains. */
export function measure(query, ids, k = 5) {
  if (new Set(ids).size !== ids.length) throw Error("Duplicate result IDs");
  const relevant = Object.values(query.relevance).filter((g) => g > 0).length;
  const top = ids.slice(0, k);
  const hits = top.filter((id) => (query.relevance[id] ?? 0) > 0).length;
  const first = ids.findIndex((id) => (query.relevance[id] ?? 0) > 0);
  const dcg = (grades) =>
    grades.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = dcg(
    Object.values(query.relevance)
      .sort((a, b) => b - a)
      .slice(0, k),
  );
  return {
    precision: hits / k,
    recall: relevant ? hits / relevant : null,
    reciprocalRank: relevant ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    ndcg: ideal ? dcg(top.map((id) => query.relevance[id] ?? 0)) / ideal : null,
    falsePositive: relevant ? null : Number(ids.length > 0),
    returnedPrecision: top.length ? hits / top.length : null,
  };
}
export function aggregate(rows) {
  const result = { queries: rows.length };
  for (const key of [
    "precision",
    "recall",
    "reciprocalRank",
    "ndcg",
    "falsePositive",
    "returnedPrecision",
  ]) {
    const values = rows.map((r) => r[key]).filter((v) => v !== null);
    result[key] = values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null;
  }
  return result;
}
export function summarize(queries, results, k = 5) {
  const rows = queries.map((q) => ({
    ...measure(q, results[q.id] ?? [], k),
    category: q.category,
  }));
  return {
    overall: aggregate(rows),
    categories: Object.fromEntries(
      [...new Set(rows.map((r) => r.category))]
        .sort()
        .map((c) => [c, aggregate(rows.filter((r) => r.category === c))]),
    ),
  };
}
