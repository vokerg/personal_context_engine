-- A separate, immutable generated-research record. Original note Markdown,
-- summary and source metadata remain untouched.
CREATE TABLE "research_reports" (
  "id" VARCHAR(36) NOT NULL,
  "ownerSubject" VARCHAR(128) NOT NULL,
  "parentNoteId" VARCHAR(36) NOT NULL,
  "captureId" VARCHAR(36) NOT NULL,
  "seriesId" VARCHAR(36) NOT NULL,
  "revision" INTEGER NOT NULL,
  "supersedesReportId" VARCHAR(36),
  "title" VARCHAR(200) NOT NULL,
  "researchedAt" TIMESTAMPTZ(3) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "contextOutcome" VARCHAR(40) NOT NULL,
  "artifact" JSONB NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "sourcePath" TEXT NOT NULL,
  "sourceRevision" VARCHAR(128) NOT NULL,
  "origin" VARCHAR(12) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_reports_parentNoteId_ownerSubject_fkey"
    FOREIGN KEY ("parentNoteId", "ownerSubject") REFERENCES "notes"("id", "ownerSubject")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "research_reports_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "research_reports_status_check" CHECK ("status" IN ('DRAFT','COMPLETE')),
  CONSTRAINT "research_reports_origin_check" CHECK ("origin" IN ('api','github'))
);
CREATE UNIQUE INDEX "research_reports_seriesId_revision_key" ON "research_reports"("seriesId", "revision");
CREATE UNIQUE INDEX "research_reports_sourcePath_sourceRevision_key" ON "research_reports"("sourcePath", "sourceRevision");
CREATE INDEX "research_reports_ownerSubject_parentNoteId_researchedAt_idx" ON "research_reports"("ownerSubject", "parentNoteId", "researchedAt");
