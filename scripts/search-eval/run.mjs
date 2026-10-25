/** Cached-vector synthetic benchmark. Never loads .env, calls a provider or
 * connects to the configured application DB. See docs/22-search-evaluation.md. */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { searchRanking } from "../../packages/db/dist/search-ranking.js";
import { baselineRanking } from "./baseline.mjs";
import { syntheticBenchmark as developmentBenchmark } from "./fixtures.mjs";
import { confirmationBenchmark } from "./confirmation.mjs";
const syntheticBenchmark =
  process.argv[4] === "--confirmation"
    ? confirmationBenchmark
    : developmentBenchmark;
import { summarize } from "./metrics.mjs";

const url = process.env.PCE_DB_TEST_URL;
if (
  !url ||
  process.env.PCE_SEARCH_EVAL_DISPOSABLE !== "I_CONFIRM_SYNTHETIC_DATABASE"
)
  throw Error("Explicit disposable test database confirmation required");
const target = new URL(url);
if (
  (target.searchParams.has("host") &&
    !target.searchParams.get("host").startsWith("/")) ||
  !["localhost", "127.0.0.1"].includes(target.hostname) ||
  !/test|eval/.test(target.pathname)
)
  throw Error("Local test/eval database required");
const [cachePath, outputPath] = process.argv.slice(2);
if (!cachePath || !outputPath)
  throw Error("Usage: node scripts/search-eval/run.mjs CACHE OUTPUT");
const vectors = JSON.parse(fs.readFileSync(cachePath, "utf8")).vectors;
const hash = (t) => createHash("sha256").update(t).digest("hex");
const vector = (t) => {
  const v = vectors[hash(t)];
  if (
    !Array.isArray(v) ||
    v.length !== 1536 ||
    !v.every(Number.isFinite) ||
    !v.some((x) => x !== 0)
  )
    throw Error("Missing/invalid cached embedding");
  return JSON.stringify(v);
};
const documents = syntheticBenchmark.documents;
// Validate cache completely before any DB writes.
for (const d of documents) vector(d.title + "\n" + d.text);
for (const q of syntheticBenchmark.queries) vector(q.query);
const owner = "synthetic-eval-" + randomUUID();
const idMap = new Map(documents.map((d) => [d.id, randomUUID()]));
const externalId = new Map([...idMap].map(([a, b]) => [b, a]));
const captures = [];
const db = new PrismaClient({ datasources: { db: { url } } });
const results = Object.fromEntries(
  ["baseline", "lexical", "semantic", "current", "fallback"].map((k) => [
    k,
    {},
  ]),
);
const timings = Object.fromEntries(Object.keys(results).map((k) => [k, []]));
let seeded = false;
try {
  const [locale] =
    await db.$queryRaw`SELECT datctype AS ctype FROM pg_database WHERE datname=current_database()`;
  if (!/utf.?8/i.test(locale.ctype))
    throw Error("UTF-8 character classification required for Russian");
  for (const [i, d] of documents.entries()) {
    const captureId = randomUUID();
    captures.push(captureId);
    const id = idMap.get(d.id);
    const capturedAt = new Date(Date.UTC(2026, 0, i + 1));
    await db.capture.create({
      data: {
        id: captureId,
        capturedAt,
        capturedAtRaw: capturedAt.toISOString(),
        source: "import",
        originalInput: d.text,
      },
    });
    await db.note.create({
      data: {
        id,
        captureId,
        ownerSubject: owner,
        schemaVersion: 1,
        capturedAt,
        capturedAtRaw: capturedAt.toISOString(),
        source: "import",
        kind: "memo",
        title: d.title,
        summary: "",
        body: d.text,
        originalInput: d.text,
        actionHint: "none",
        reviewRequired: false,
        sourcePath: "eval/" + id,
        sourceRevision: "v1",
        contentHash: hash(d.text),
      },
    });
    seeded = true;
    const chunkId = hash(owner + d.id);
    await db.noteChunk.create({
      data: {
        id: chunkId,
        noteId: id,
        ownerSubject: owner,
        sourceRevision: "v1",
        noteContentHash: hash(d.text),
        chunkerVersion: "unicode-nfc-lf-2048-v1",
        section: "original",
        ordinal: 0,
        startOffset: 0,
        endOffset: d.text.length,
        contentHash: hash(d.text),
        text: d.text,
      },
    });
    await db.$executeRaw`INSERT INTO chunk_embeddings (id,"chunkId",provider,"modelId",dimensions,status,vector,"updatedAt") VALUES (${hash(chunkId + "embedding")},${chunkId},'openai','text-embedding-3-small',1536,'READY',${vector(d.title + "\n" + d.text)}::vector,now())`;
  }
  for (const q of syntheticBenchmark.queries) {
    for (const name of Object.keys(results)) {
      const cte =
        name === "current" || name === "fallback"
          ? searchRanking(
              owner,
              { query: q.query },
              name === "fallback" ? null : vector(q.query),
            )
          : baselineRanking(
              owner,
              q.query,
              vector(q.query),
              name === "baseline" ? "hybrid" : name,
            );
      const start = performance.now();
      const rows = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout','2000',true)`;
        return tx.$queryRaw(
          Prisma.sql`${cte} SELECT f.id FROM ranked r JOIN filtered f ON f.id=r.id ORDER BY r.score DESC,f."capturedAt" DESC,f.id COLLATE "C" LIMIT 201`,
        );
      });
      timings[name].push(performance.now() - start);
      results[name][q.id] = rows.map((r) => externalId.get(r.id));
    }
  }
  const summary = {};
  for (const split of [
    ...new Set(syntheticBenchmark.queries.map((q) => q.split)),
  ]) {
    const queries = syntheticBenchmark.queries.filter((q) => q.split === split);
    summary[split] = Object.fromEntries(
      Object.entries(results).map(([name, ids]) => [
        name,
        Object.fromEntries(
          [1, 5, 10, 200].map((k) => [k, summarize(queries, ids, k)]),
        ),
      ]),
    );
  }
  const latency = Object.fromEntries(
    Object.entries(timings).map(([name, t]) => {
      const sorted = t.slice(5).sort((a, b) => a - b);
      return [
        name,
        {
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
        },
      ];
    }),
  );
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        version: 1,
        fixtureHash: hash(JSON.stringify(syntheticBenchmark)),
        summary,
        latency,
        results,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      queries: syntheticBenchmark.queries.length,
      documents: documents.length,
      latency,
    }),
  );
} finally {
  if (seeded) await db.note.deleteMany({ where: { ownerSubject: owner } });
  if (captures.length)
    await db.capture.deleteMany({ where: { id: { in: captures } } });
  await db.$disconnect();
}
