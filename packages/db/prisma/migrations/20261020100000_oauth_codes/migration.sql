CREATE TABLE "oauth_codes" (
 "codeHash" CHAR(64) PRIMARY KEY,
 "sessionId" UUID NOT NULL REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
 "clientId" VARCHAR(128) NOT NULL,
 "redirectUri" VARCHAR(2048) NOT NULL,
 "resource" VARCHAR(256) NOT NULL,
 "scopes" TEXT[] NOT NULL,
 "challenge" CHAR(43) NOT NULL,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "consumedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "oauth_codes_expiresAt_idx" ON "oauth_codes"("expiresAt");
