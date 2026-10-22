-- Owner-scoped mutable effective-tag adjustments, without altering original
-- Markdown tags, source revision or embedding chunks.
CREATE TABLE "note_tag_overrides" (
  "noteId" VARCHAR(36) NOT NULL,
  "ownerSubject" VARCHAR(128) NOT NULL,
  "added" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "removed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "note_tag_overrides_pkey" PRIMARY KEY ("noteId"),
  CONSTRAINT "note_tag_overrides_noteId_ownerSubject_fkey"
    FOREIGN KEY ("noteId", "ownerSubject") REFERENCES "notes"("id","ownerSubject")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "note_tag_overrides_disjoint_check"
    CHECK (NOT ("added" && "removed"))
);
CREATE UNIQUE INDEX "note_tag_overrides_noteId_ownerSubject_key" ON "note_tag_overrides"("noteId", "ownerSubject");
CREATE INDEX "note_tag_overrides_ownerSubject_idx" ON "note_tag_overrides"("ownerSubject");
