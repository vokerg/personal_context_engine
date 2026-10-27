-- CreateTable
CREATE TABLE "task_extraction_batches" (
    "id" VARCHAR(36) NOT NULL,
    "ownerSubject" VARCHAR(128) NOT NULL,
    "captureId" VARCHAR(36) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "artifact" JSONB NOT NULL,
    "origin" VARCHAR(12) NOT NULL,
    "sourcePath" TEXT,
    "sourceRevision" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_extraction_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_ingress_attempts" (
    "id" CHAR(64) NOT NULL,
    "checkpointKey" CHAR(64) NOT NULL,
    "ownerSubject" VARCHAR(128) NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "sourceRevision" VARCHAR(128) NOT NULL,
    "batchId" VARCHAR(36),
    "status" VARCHAR(24) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_ingress_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_extraction_batches_ownerSubject_captureId_key" ON "task_extraction_batches"("ownerSubject", "captureId");

-- CreateIndex
CREATE INDEX "task_ingress_attempts_ownerSubject_batchId_idx" ON "task_ingress_attempts"("ownerSubject", "batchId");
