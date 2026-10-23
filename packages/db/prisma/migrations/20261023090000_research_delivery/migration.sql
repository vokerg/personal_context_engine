-- CreateTable
CREATE TABLE "research_chunks" (
    "id" CHAR(64) NOT NULL,
    "reportId" VARCHAR(36) NOT NULL,
    "ownerSubject" VARCHAR(128) NOT NULL,
    "sourceRevision" VARCHAR(128) NOT NULL,
    "reportContentHash" CHAR(64) NOT NULL,
    "chunkerVersion" VARCHAR(64) NOT NULL,
    "section" VARCHAR(24) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_embeddings" (
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
    "usageTokens" INTEGER,
    "estimatedCostNanoUsd" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "research_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_ingress_attempts" (
    "id" CHAR(64) NOT NULL,
    "checkpointKey" CHAR(64) NOT NULL,
    "ownerSubject" VARCHAR(128) NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "sourceRevision" VARCHAR(128) NOT NULL,
    "parentNoteId" VARCHAR(36),
    "status" VARCHAR(24) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "research_ingress_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "research_chunks_ownerSubject_reportId_idx" ON "research_chunks"("ownerSubject", "reportId");

-- CreateIndex
CREATE UNIQUE INDEX "research_chunks_reportId_chunkerVersion_section_ordinal_key" ON "research_chunks"("reportId", "chunkerVersion", "section", "ordinal");

-- CreateIndex
CREATE INDEX "research_embeddings_status_nextRetryAt_idx" ON "research_embeddings"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "research_embeddings_chunkId_modelId_dimensions_key" ON "research_embeddings"("chunkId", "modelId", "dimensions");

-- CreateIndex
CREATE INDEX "research_ingress_attempts_ownerSubject_parentNoteId_idx" ON "research_ingress_attempts"("ownerSubject", "parentNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "research_reports_id_ownerSubject_key" ON "research_reports"("id", "ownerSubject");

-- AddForeignKey
ALTER TABLE "research_chunks" ADD CONSTRAINT "research_chunks_reportId_ownerSubject_fkey" FOREIGN KEY ("reportId", "ownerSubject") REFERENCES "research_reports"("id", "ownerSubject") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "research_embeddings" ADD CONSTRAINT "research_embeddings_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "research_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE INDEX research_embeddings_vector_hnsw ON research_embeddings USING hnsw (vector vector_cosine_ops) WHERE status = 'READY';
CREATE INDEX research_reports_document_gin ON research_reports USING gin (to_tsvector('simple'::regconfig, title || ' ' || (artifact->>'findings') || ' ' || coalesce(artifact->>'question','') || ' ' || coalesce((artifact->'claims')::text,'')));
ALTER TABLE research_ingress_attempts ADD CONSTRAINT research_ingress_status_check CHECK (status IN ('IMPORTED','RETRY','INVALID'));
