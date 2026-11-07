-- Additive staging only; no legacy originals or attempts are changed.
CREATE TABLE "ingestion_staging" (
    "id" UUID NOT NULL,
    "ownerSubject" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(24) NOT NULL,
    "artifactType" VARCHAR(24) NOT NULL,
    "repository" VARCHAR(256) NOT NULL,
    "branch" VARCHAR(128) NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "sourceRevision" VARCHAR(128) NOT NULL,
    "rawContent" BYTEA NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "leaseOwner" VARCHAR(128),
    "leaseUntil" TIMESTAMPTZ(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "processedAt" TIMESTAMPTZ(3),
    "canonicalId" VARCHAR(36),

    CONSTRAINT "ingestion_staging_pkey" PRIMARY KEY ("id")
);


CREATE INDEX "ingestion_staging_ownerSubject_status_nextRetryAt_idx" ON "ingestion_staging"("ownerSubject", "status", "nextRetryAt");
CREATE INDEX "ingestion_staging_leaseUntil_idx" ON "ingestion_staging"("leaseUntil");
CREATE UNIQUE INDEX "ingestion_staging_source_key" ON "ingestion_staging"("ownerSubject", "provider", "repository", "branch", "sourcePath", "sourceRevision");
