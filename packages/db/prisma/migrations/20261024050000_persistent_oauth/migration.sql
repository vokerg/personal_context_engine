-- Preserve all existing grant lifetimes; new OAuth connections opt into NULL.
ALTER TABLE "api_grants" ALTER COLUMN "refreshExpiresAt" DROP NOT NULL;
