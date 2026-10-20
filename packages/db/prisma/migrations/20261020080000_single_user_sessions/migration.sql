CREATE TABLE "auth_sessions" (
 "id" UUID PRIMARY KEY, "ownerSubject" VARCHAR(128) NOT NULL,
 "issuer" VARCHAR(256) NOT NULL, "audience" VARCHAR(256) NOT NULL,
 "tokenHash" CHAR(64) NOT NULL UNIQUE, "csrfHash" CHAR(64) NOT NULL,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, "absoluteExpiresAt" TIMESTAMPTZ(3) NOT NULL,
 "revokedAt" TIMESTAMPTZ(3), "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "auth_sessions_ownerSubject_expiresAt_idx" ON "auth_sessions"("ownerSubject", "expiresAt");
CREATE TABLE "api_grants" (
 "id" UUID PRIMARY KEY, "sessionId" UUID NOT NULL REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
 "clientId" VARCHAR(128) NOT NULL, "audience" VARCHAR(256) NOT NULL, "scopes" TEXT[] NOT NULL,
 "accessHash" CHAR(64) NOT NULL UNIQUE, "refreshHash" CHAR(64) NOT NULL UNIQUE,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, "refreshExpiresAt" TIMESTAMPTZ(3) NOT NULL, "revokedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "api_grants_sessionId_idx" ON "api_grants"("sessionId");
