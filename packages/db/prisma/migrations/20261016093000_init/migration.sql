-- Synthetic-safe projection schema. No production data or credentials.
CREATE TYPE "ImportState" AS ENUM ('PERSISTED', 'FINALIZED', 'REJECTED', 'RETRY');
CREATE TYPE "AttemptStatus" AS ENUM ('PENDING', 'LEASED', 'PERSISTED', 'FINALIZED', 'RETRY', 'REJECTED');

CREATE TABLE "captures" (
  "id" VARCHAR(36) NOT NULL,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL,
  "capturedAtRaw" VARCHAR(40) NOT NULL,
  "source" VARCHAR(32) NOT NULL,
  "timezone" VARCHAR(128),
  "originalInput" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "captures_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notes" (
  "id" VARCHAR(36) NOT NULL,
  "captureId" VARCHAR(36) NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL,
  "capturedAtRaw" VARCHAR(40) NOT NULL,
  "source" VARCHAR(32) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "projects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "relatedNoteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "actionHint" VARCHAR(32) NOT NULL,
  "reviewRequired" BOOLEAN NOT NULL,
  "occurredAt" TIMESTAMPTZ(3),
  "occurredAtRaw" VARCHAR(40),
  "dueAt" TIMESTAMPTZ(3),
  "dueAtRaw" VARCHAR(40),
  "timezone" VARCHAR(128),
  "processingModel" VARCHAR(256),
  "summary" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "originalInput" TEXT NOT NULL,
  "sourcePath" TEXT NOT NULL,
  "sourceRevision" VARCHAR(128) NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "canonicalPath" TEXT,
  "state" "ImportState" NOT NULL DEFAULT 'PERSISTED',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "processing_attempts" (
  "id" UUID NOT NULL,
  "sourcePath" TEXT NOT NULL,
  "sourceRevision" VARCHAR(128) NOT NULL,
  "noteId" VARCHAR(36),
  "status" "AttemptStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" VARCHAR(128),
  "leaseUntil" TIMESTAMPTZ(3),
  "nextRetryAt" TIMESTAMPTZ(3),
  "lastErrorCode" VARCHAR(64),
  "committedAt" TIMESTAMPTZ(3),
  "finalizedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "processing_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notes_sourcePath_sourceRevision_key" ON "notes"("sourcePath", "sourceRevision");
CREATE INDEX "notes_captureId_idx" ON "notes"("captureId");
CREATE INDEX "notes_state_idx" ON "notes"("state");
CREATE UNIQUE INDEX "processing_attempts_sourcePath_sourceRevision_key" ON "processing_attempts"("sourcePath", "sourceRevision");
CREATE INDEX "processing_attempts_status_nextRetryAt_idx" ON "processing_attempts"("status", "nextRetryAt");
CREATE INDEX "processing_attempts_leaseUntil_idx" ON "processing_attempts"("leaseUntil");

ALTER TABLE "notes" ADD CONSTRAINT "notes_captureId_fkey"
  FOREIGN KEY ("captureId") REFERENCES "captures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "processing_attempts" ADD CONSTRAINT "processing_attempts_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
