-- #47: token usage and estimated USD nano-units for successfully indexed chunks.
-- Actual provider billing (including failed requests) may differ.
ALTER TABLE "chunk_embeddings"
  ADD COLUMN "usageTokens" INTEGER,
  ADD COLUMN "estimatedCostNanoUsd" BIGINT;
ALTER TABLE "chunk_embeddings"
  ADD CONSTRAINT "chunk_embeddings_usage_nonnegative_check"
  CHECK (("usageTokens" IS NULL OR "usageTokens" >= 0)
    AND ("estimatedCostNanoUsd" IS NULL OR "estimatedCostNanoUsd" >= 0));
