-- Reversible owner-scoped workspace removal and archiving. Originals and
-- provenance remain intact; normal readers exclude removed rows while archived
-- rows remain available with an explicit archived status.
ALTER TABLE "notes" ADD COLUMN "removedAt" TIMESTAMPTZ(3);
ALTER TABLE "notes" ADD COLUMN "removedBy" VARCHAR(128);
ALTER TABLE "notes" ADD COLUMN "archivedAt" TIMESTAMPTZ(3);
ALTER TABLE "notes" ADD COLUMN "archivedBy" VARCHAR(128);
CREATE INDEX "notes_ownerSubject_removedAt_idx" ON "notes"("ownerSubject", "removedAt");
CREATE INDEX "notes_ownerSubject_archivedAt_idx" ON "notes"("ownerSubject", "archivedAt");
