CREATE TABLE "api_capture_receipts" (
 "id" UUID PRIMARY KEY, "ownerSubject" VARCHAR(128) NOT NULL,
 "idempotencyHash" CHAR(64) NOT NULL, "payloadHash" CHAR(64) NOT NULL,
 "noteIds" TEXT[] NOT NULL, "markdowns" JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("ownerSubject","idempotencyHash")
);
CREATE TABLE "db_processing_jobs" (
 "id" UUID PRIMARY KEY, "ownerSubject" VARCHAR(128) NOT NULL, "noteId" VARCHAR(36) NOT NULL,
 "sourceRevision" VARCHAR(128) NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
 "attemptCount" INTEGER NOT NULL DEFAULT 0, "leaseOwner" VARCHAR(128), "leaseUntil" TIMESTAMPTZ(3),
 "nextRetryAt" TIMESTAMPTZ(3), "lastErrorCode" VARCHAR(64),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("noteId","ownerSubject") REFERENCES "notes"("id","ownerSubject") ON DELETE CASCADE ON UPDATE RESTRICT,
 UNIQUE("noteId","sourceRevision"),
 CHECK ("status" IN ('PENDING','LEASED','PREPARED','RETRY','FAILED'))
);
CREATE INDEX "db_processing_jobs_ownerSubject_status_nextRetryAt_idx" ON "db_processing_jobs"("ownerSubject","status","nextRetryAt");
