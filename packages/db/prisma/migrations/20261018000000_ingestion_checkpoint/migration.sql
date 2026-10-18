CREATE TABLE "ingestion_checkpoints" (
    "key" CHAR(64) NOT NULL,
    "cursor" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastScanAt" TIMESTAMPTZ(3),
    "observedRevision" VARCHAR(64),
    "reconciledRevision" VARCHAR(64),
    "reconciledAt" TIMESTAMPTZ(3),
    "reconciliationPending" BOOLEAN NOT NULL DEFAULT true,
    "knownNoteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ingestion_checkpoints_pkey" PRIMARY KEY ("key")
);
