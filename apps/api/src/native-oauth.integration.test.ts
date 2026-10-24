import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@pce/db";
import { createApp } from "./app.js";
import { oauthClients } from "./oauth.js";
import { createSessionAuth, type SessionConfig } from "./session-auth.js";

/** Real localhost HTTP + disposable PostgreSQL; never uses a private corpus. */
describe.skipIf(!process.env.PCE_DB_TEST_URL)(
  "standalone iOS public OAuth (MCP transport disabled)",
  () => {
    const owner = "native-oauth-" + randomUUID();
    const redirect = "pce://oauth/callback";
    const state = "s".repeat(32);
    const verifier = "v".repeat(64);
    let app: ReturnType<typeof createApp>;
    let db: PrismaClient;
    let issuer: string;
    let cookie: string;
    let csrf: string;

    const form = async (path: string, fields: Record<string, string>) =>
      fetch(issuer + path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
        redirect: "manual",
      });
    const authorizeParams = () => ({
      response_type: "code",
      client_id: "synthetic-ios",
      redirect_uri: redirect,
      resource: issuer + "/mcp",
      scope: "notes:read",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const exchange = (code: string, codeVerifier = verifier) => form("/oauth/token", {
      grant_type: "authorization_code",
      code, client_id: "synthetic-ios", redirect_uri: redirect,
      resource: issuer + "/mcp", code_verifier: codeVerifier,
    });

    beforeAll(async () => {
      db = new PrismaClient({ datasources: { db: { url: process.env.PCE_DB_TEST_URL! } } });
      await db.$connect();
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      issuer = "http://127.0.0.1:" + port;
      const config: SessionConfig = {
        mode: "dev-single-user",
        ownerSubject: owner,
        origin: "http://127.0.0.1:4312",
        issuer,
        audience: issuer + "/mcp",
        secure: false,
      };
      const auth = createSessionAuth(db, config);
      app = createApp({
        config: {
          environment: "development", host: "127.0.0.1", port: 0,
          requiresDatabase: false, corsOrigin: config.origin,
        },
        dependencies: {
          sessionAuth: auth,
          oauth: { db, clients: oauthClients({
            PCE_MOBILE_OAUTH_ENABLED: "true",
            PCE_MOBILE_OAUTH_CLIENT: JSON.stringify({
              clientId: "synthetic-ios", redirectUris: [redirect],
              scopes: ["notes:read", "capture:write", "tags:write"],
            }),
          }) },
          notes: {
            listByOwner: async () => [],
            getByOwner: async () => null,
          },
        },
      });
      await app.listen({ host: "127.0.0.1", port });
      const login = await fetch(issuer + "/auth/dev-session", {
        method: "POST", headers: {
          origin: config.origin, "content-type": "application/json",
        }, body: "{}",
      });
      expect(login.status).toBe(200);
      cookie = login.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
      csrf = /pce_csrf=([^;]+)/.exec(cookie)![1]!;
    });
    afterAll(async () => {
      if (app) await app.close();
      if (db) {
        await db.authSession.deleteMany({ where: { ownerSubject: owner } });
        await db.$disconnect();
      }
    });

    it("issues short-lived owner-scoped access via registered iOS PKCE without exposing MCP", async () => {
      const metadata = await fetch(issuer + "/.well-known/oauth-authorization-server");
      expect(metadata.status).toBe(200);
      expect((await metadata.json()).issuer).toBe(issuer);
      expect((await fetch(issuer + "/mcp")).status).toBe(404);
      const invalid = await fetch(issuer + "/oauth/authorize?" +
        new URLSearchParams({ ...authorizeParams(), redirect_uri: "pce://notes/other" }), {
          headers: { cookie },
        });
      expect(invalid.status).toBe(400);
      const deniedScope = await fetch(issuer + "/oauth/authorize?" +
        new URLSearchParams({ ...authorizeParams(), scope: "admin" }), {
          headers: { cookie },
        });
      expect(deniedScope.status).toBe(400);
      const consent = await fetch(issuer + "/oauth/authorize?" +
        new URLSearchParams(authorizeParams()), { headers: { cookie } });
      expect(consent.status).toBe(200);
      expect(consent.headers.get("content-security-policy")).toContain("form-action 'self' pce:");
      const allow = await fetch(issuer + "/oauth/authorize", {
        method: "POST", headers: {
          cookie, origin: issuer,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ ...authorizeParams(), csrf, decision: "allow" }),
        redirect: "manual",
      });
      expect(allow.status).toBe(303);
      const result = new URL(allow.headers.get("location")!);
      expect(result.protocol).toBe("pce:");
      expect(result.searchParams.get("state")).toBe(state);
      expect(result.searchParams.get("iss")).toBe(issuer);
      const code = result.searchParams.get("code")!;
      expect((await exchange(code, "x".repeat(64))).status).toBe(400);
      const issued = await exchange(code);
      expect(issued.status).toBe(200);
      const pair = await issued.json();
      expect(pair.scope).toBe("notes:read");
      expect(pair.expires_in).toBe(900);
      expect((await exchange(code)).status).toBe(400);
      expect((await fetch(issuer + "/api/v1/notes", {
        headers: { Authorization: "Bearer " + pair.access_token },
      })).status).toBe(200);

      const refreshFields = {
        grant_type: "refresh_token", refresh_token: pair.refresh_token,
        client_id: "synthetic-ios", resource: issuer + "/mcp",
      };
      const attempts = await Promise.all([
        form("/oauth/token", refreshFields),
        form("/oauth/token", refreshFields),
      ]);
      expect(attempts.map((r) => r.status).sort()).toEqual([200, 400]);
      const rotated = await attempts.find((r) => r.ok)!.json();
      expect(rotated.refresh_token).not.toBe(pair.refresh_token);
      expect((await fetch(issuer + "/api/v1/notes", {
        headers: { Authorization: "Bearer " + pair.access_token },
      })).status).toBe(401);
      expect((await fetch(issuer + "/api/v1/notes", {
        headers: { Authorization: "Bearer " + rotated.access_token },
      })).status).toBe(200);
      expect((await form("/oauth/revoke", {
        token: rotated.refresh_token, client_id: "synthetic-ios",
        token_type_hint: "refresh_token",
      })).status).toBe(200);
      expect((await fetch(issuer + "/api/v1/notes", {
        headers: { Authorization: "Bearer " + rotated.access_token },
      })).status).toBe(401);
    });
  },
);
