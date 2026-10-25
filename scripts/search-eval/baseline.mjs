import { Prisma } from "@prisma/client";
// Frozen fd33b58/#76 note-ranking baseline, for synthetic experiments only.
// No filters are needed: the runner uses one disposable synthetic owner.
export function baselineRanking(owner, query, literal, branch = "hybrid") {
  const text = Prisma.sql`title||E'\n'||summary||E'\n'||body||E'\n'||"originalInput"`;
  const q = Prisma.sql`to_tsquery('simple',replace(plainto_tsquery('simple',${query})::text,' & ',' | '))`;
  return Prisma.sql`WITH filtered AS (
 SELECT n.*,to_tsvector('simple',${text}) AS document FROM notes n WHERE "ownerSubject"=${owner} AND "removedAt" IS NULL
 ), lexical AS (
 SELECT id,row_number() OVER(ORDER BY ts_rank(document,${q}) DESC,"capturedAt" DESC,id COLLATE "C") AS rank
 FROM filtered WHERE ${branch === "semantic" ? Prisma.sql`false` : Prisma.sql`document @@ ${q} OR strpos(lower(${text}),lower(${query}))>0`}
 ORDER BY rank LIMIT 200
 ), distances AS (
 ${
   literal && branch !== "lexical"
     ? Prisma.sql`SELECT f.id,min(e.vector <=> ${literal}::vector) AS distance FROM filtered f
 JOIN note_chunks c ON c."noteId"=f.id AND c."ownerSubject"=f."ownerSubject" JOIN chunk_embeddings e ON e."chunkId"=c.id
 WHERE c."ownerSubject"=${owner} AND c."sourceRevision"=f."sourceRevision" AND c."noteContentHash"=f."contentHash"
 AND c."chunkerVersion"='unicode-nfc-lf-2048-v1' AND e.provider='openai' AND e."modelId"='text-embedding-3-small'
 AND e.dimensions=1536 AND e.status='READY' AND e.vector IS NOT NULL GROUP BY f.id`
     : Prisma.sql`SELECT id,0.0::float8 AS distance FROM filtered WHERE false`
 }
 ), semantic AS (
 SELECT id,row_number() OVER(ORDER BY distance,id COLLATE "C") AS rank FROM distances WHERE distance<0.85
 ORDER BY distance,id COLLATE "C" LIMIT 200
 ), ranked AS (
 SELECT coalesce(l.id,s.id) AS id,coalesce(1.0/(60+l.rank),0)+coalesce(1.0/(60+s.rank),0) AS score
 FROM lexical l FULL JOIN semantic s ON l.id=s.id)`;
}
