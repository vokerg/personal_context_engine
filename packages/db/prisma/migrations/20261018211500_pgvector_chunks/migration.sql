-- Issue #46: additive, no provider calls or automatic backfill.
-- Target PostgreSQL host must expose pgvector before migration deployment.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "EmbeddingStatus" AS ENUM ('PENDING', 'LEASED', 'READY', 'RETRY', 'FAILED');

-- Composite ownership FK makes cross-owner chunks impossible at the database
-- boundary; legacy rows with NULL owner cannot be indexed.
CREATE UNIQUE INDEX "notes_id_ownerSubject_key" ON "notes"("id", "ownerSubject");

CREATE TABLE "note_chunks" (
  "id" CHAR(64) NOT NULL,
  "noteId" VARCHAR(36) NOT NULL,
  "ownerSubject" VARCHAR(128) NOT NULL,
  "sourceRevision" VARCHAR(128) NOT NULL,
  "noteContentHash" CHAR(64) NOT NULL,
  "chunkerVersion" VARCHAR(64) NOT NULL,
  "section" VARCHAR(24) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "startOffset" INTEGER NOT NULL,
  "endOffset" INTEGER NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "note_chunks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "note_chunks_offsets_check" CHECK ("ordinal" >= 0 AND "startOffset" >= 0 AND "endOffset" > "startOffset"),
  CONSTRAINT "note_chunks_section_check" CHECK ("section" IN ('original', 'summary', 'body'))
);

CREATE UNIQUE INDEX "note_chunks_noteId_chunkerVersion_section_ordinal_key"
  ON "note_chunks"("noteId", "chunkerVersion", "section", "ordinal");
CREATE INDEX "note_chunks_ownerSubject_noteId_idx" ON "note_chunks"("ownerSubject", "noteId");

ALTER TABLE "note_chunks" ADD CONSTRAINT "note_chunks_noteId_ownerSubject_fkey"
  FOREIGN KEY ("noteId", "ownerSubject") REFERENCES "notes"("id", "ownerSubject")
  ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "chunk_embeddings" (
  "id" CHAR(64) NOT NULL,
  "chunkId" CHAR(64) NOT NULL,
  "provider" VARCHAR(64) NOT NULL,
  "modelId" VARCHAR(128) NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "status" "EmbeddingStatus" NOT NULL DEFAULT 'PENDING',
  "vector" vector(1536),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" VARCHAR(128),
  "leaseUntil" TIMESTAMPTZ(3),
  "nextRetryAt" TIMESTAMPTZ(3),
  "lastErrorCode" VARCHAR(64),
  "indexedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "chunk_embeddings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chunk_embeddings_dimensions_check" CHECK ("dimensions" = 1536),
  CONSTRAINT "chunk_embeddings_vector_status_check" CHECK (
    ("status" = 'READY' AND "vector" IS NOT NULL)
    OR ("status" <> 'READY' AND "vector" IS NULL)
  )
);

CREATE UNIQUE INDEX "chunk_embeddings_chunkId_modelId_dimensions_key"
  ON "chunk_embeddings"("chunkId", "modelId", "dimensions");
CREATE INDEX "chunk_embeddings_status_nextRetryAt_idx"
  ON "chunk_embeddings"("status", "nextRetryAt");

ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunkId_fkey"
  FOREIGN KEY ("chunkId") REFERENCES "note_chunks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
