ALTER TABLE "notes" ADD COLUMN "ownerSubject" VARCHAR(128);
CREATE INDEX "notes_ownerSubject_capturedAt_idx" ON "notes"("ownerSubject", "capturedAt");
