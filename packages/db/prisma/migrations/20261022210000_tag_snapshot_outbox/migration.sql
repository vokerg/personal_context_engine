-- A taxonomy job has no note foreign key. Jobs are independent of note
-- ingestion, embedding preparation, and GitHub-origin capture.
CREATE TABLE "tag_snapshot_outbox" (
  "ownerSubject" VARCHAR(128) NOT NULL PRIMARY KEY,
  "desiredRevision" INTEGER NOT NULL DEFAULT 0,
  "publishedRevision" INTEGER NOT NULL DEFAULT -1,
  "publishedHash" CHAR(64),
  "publishedAt" TIMESTAMPTZ(3),
  "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" VARCHAR(128),
  "leaseUntil" TIMESTAMPTZ(3),
  "nextRetryAt" TIMESTAMPTZ(3),
  "lastErrorCode" VARCHAR(64),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "tag_snapshot_revision_check" CHECK ("desiredRevision" >= 0 AND "publishedRevision" >= -1),
  CONSTRAINT "tag_snapshot_status_check" CHECK ("status" IN ('PENDING','LEASED','RETRY','PUBLISHED','FAILED'))
);
CREATE INDEX "tag_snapshot_outbox_status_nextRetryAt_idx" ON "tag_snapshot_outbox" ("status","nextRetryAt");

-- Existing approvals predate this feature: bootstrap their export intent
-- without publishing to GitHub. Actual publication remains disabled by default.
INSERT INTO "tag_snapshot_outbox" ("ownerSubject", "desiredRevision")
SELECT "ownerSubject", "revision" FROM "tag_registry_revisions";
