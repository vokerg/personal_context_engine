-- Independent owner-curated tag vocabulary. Existing note tags and source
-- provenance remain untouched; DB-only approvals need no GitHub write.
CREATE TABLE "tag_approvals" (
  "ownerSubject" VARCHAR(128) NOT NULL,
  "slug" VARCHAR(64) NOT NULL,
  "displayName" VARCHAR(120),
  "description" VARCHAR(500),
  "approvedBy" VARCHAR(24) NOT NULL DEFAULT 'owner',
  "approvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tag_approvals_pkey" PRIMARY KEY ("ownerSubject", "slug"),
  CONSTRAINT "tag_approvals_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE "tag_registry_revisions" (
  "ownerSubject" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tag_registry_revisions_pkey" PRIMARY KEY ("ownerSubject")
);
