-- No note text or provider credentials in budget/checkpoint records.
CREATE TABLE "embedding_daily_budgets" (
  "ownerSubject" VARCHAR(128) NOT NULL,
  "day" DATE NOT NULL,
  "reservedTokens" INTEGER NOT NULL DEFAULT 0,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("ownerSubject", "day"),
  CHECK ("reservedTokens" BETWEEN 0 AND 60000),
  CHECK ("requestCount" >= 0)
);
CREATE TABLE "embedding_scans" (
  "ownerSubject" VARCHAR(128) PRIMARY KEY,
  "afterNoteId" VARCHAR(36),
  "windowStartedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "windowRequests" INTEGER NOT NULL DEFAULT 0 CHECK ("windowRequests" BETWEEN 0 AND 4)
);
