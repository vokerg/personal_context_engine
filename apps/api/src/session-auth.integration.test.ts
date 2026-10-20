import { randomUUID, scryptSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@pce/db";
import { createApp } from "./app.js";
import {
  createSessionAuth,
  sessionConfig,
  type SessionConfig,
} from "./session-auth.js";

const url = process.env.PCE_DB_TEST_URL;
const owner = "auth-" + randomUUID();
const config: SessionConfig = {
  mode: "dev-single-user",
  ownerSubject: owner,
  origin: "http://127.0.0.1:4310",
  issuer: "http://127.0.0.1:3110",
  audience: "http://127.0.0.1:3110/mcp",
  secure: false,
};
describe.skipIf(!url)(
  "persisted single-user sessions and scoped API grants",
  () => {
    let db: PrismaClient;
    beforeAll(async () => {
      db = new PrismaClient({ datasources: { db: { url: url! } } });
      await db.$connect();
    });
    afterAll(async () => {
      if (db) {
        await db.authSession.deleteMany({ where: { ownerSubject: owner } });
        await db.$disconnect();
      }
    });
    const appFor = (auth: ReturnType<typeof createSessionAuth>) =>
      createApp({
        config: {
          host: "127.0.0.1",
          port: 3110,
          environment: "test",
          corsOrigin: config.origin,
          requiresDatabase: false,
          auth: null,
        },
        dependencies: { sessionAuth: auth },
      });
    it("keeps default routes public-only and rejects insecure hosted/development settings", () => {
      expect(() =>
        sessionConfig({
          PCE_AUTH_MODE: "dev-single-user",
          NODE_ENV: "production",
        }),
      ).toThrow();
      expect(() =>
        sessionConfig({
          PCE_AUTH_MODE: "dev-single-user",
          API_HOST: "0.0.0.0",
        }),
      ).toThrow();
      expect(() =>
        sessionConfig({
          PCE_AUTH_MODE: "single-user",
          PCE_WEB_ORIGIN: "http://remote.example",
        }),
      ).toThrow();
      expect(() => sessionConfig({ PCE_AUTH_MODE: "single-user" })).toThrow();
      expect(sessionConfig({})).toBeUndefined();
    });
    it("authenticates cookie sessions, binds CSRF and revokes every delegated token on logout", async () => {
      const auth = createSessionAuth(db, config),
        app = appFor(auth);
      try {
        const denied = await app.inject({
          method: "POST",
          url: "/auth/dev-session",
          headers: { origin: "http://evil.example" },
          payload: {},
        });
        expect(denied.statusCode).toBe(403);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/auth/dev-session",
              headers: { origin: config.origin },
              payload: { ownerSubject: "foreign" },
            })
          ).statusCode,
        ).toBe(400);
        const login = await app.inject({
          method: "POST",
          url: "/auth/dev-session",
          headers: { origin: config.origin },
          payload: {},
        });
        expect(login.statusCode).toBe(200);
        const cookie = login.cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        const csrf = login.cookies.find((c) => c.name === "pce_csrf")!.value;
        expect(
          login.cookies.find((c) => c.name === "pce_session")!.httpOnly,
        ).toBe(true);
        expect(
          (await app.inject({ url: "/auth/session", headers: { cookie } }))
            .statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/auth/token",
              headers: { origin: config.origin, cookie },
              payload: { scope: "notes:read" },
            })
          ).statusCode,
        ).toBe(403);
        const issued = await app.inject({
          method: "POST",
          url: "/auth/token",
          headers: { origin: config.origin, cookie, "x-pce-csrf": csrf },
          payload: { scope: "notes:read" },
        });
        expect(issued.statusCode).toBe(200);
        const pair = issued.json();
        expect(await auth.verifyAccessToken(pair.access_token)).toEqual({
          subject: owner,
          scopes: ["notes:read"],
        });
        expect(
          await createSessionAuth(db, {
            ...config,
            issuer: "https://production.example",
          }).verifyAccessToken(pair.access_token),
        ).toBeNull();
        expect(
          await createSessionAuth(db, {
            ...config,
            ownerSubject: "foreign",
          }).verifyAccessToken(pair.access_token),
        ).toBeNull();
        expect(await auth.verifyAccessToken("forged")).toBeNull();
        const stored = await db.apiGrant.findFirstOrThrow({
          where: { session: { ownerSubject: owner } },
        });
        expect(stored.accessHash).not.toBe(pair.access_token);
        const refreshes = await Promise.all([
          auth.refresh(pair.refresh_token, "pce-local"),
          auth.refresh(pair.refresh_token, "pce-local"),
        ]);
        expect(refreshes.filter(Boolean)).toHaveLength(1);
        expect(await auth.verifyAccessToken(pair.access_token)).toBeNull();
        expect(await auth.refresh(pair.refresh_token, "pce-local")).toBeNull();
        const rotated = refreshes.find(Boolean)!;
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/auth/logout",
              headers: { origin: config.origin, cookie, "x-pce-csrf": "wrong" },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/auth/logout",
              headers: { origin: config.origin, cookie, "x-pce-csrf": csrf },
            })
          ).statusCode,
        ).toBe(200);
        expect(await auth.verifyAccessToken(rotated.access_token)).toBeNull();
        expect(
          await auth.refresh(rotated.refresh_token, "pce-local"),
        ).toBeNull();
        expect(
          (await app.inject({ url: "/auth/session", headers: { cookie } }))
            .statusCode,
        ).toBe(401);
      } finally {
        await app.close();
      }
    });
    it("uses SportOS-compatible scrypt credentials and disables local bootstrap in password mode", async () => {
      const salt = Buffer.alloc(16, 4),
        hash = scryptSync("synthetic-password", salt, 64, {
          N: 65536,
          r: 8,
          p: 1,
          maxmem: 128 * 1024 * 1024,
        });
      const auth = createSessionAuth(db, {
          ...config,
          mode: "single-user",
          username: "synthetic",
          passwordHash: `scrypt-v1:${salt.toString("hex")}:${hash.toString("hex")}`,
        }),
        app = appFor(auth);
      try {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/auth/dev-session",
              headers: { origin: config.origin },
              payload: {},
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/auth/password",
              headers: { origin: config.origin },
              payload: { username: "synthetic", password: "wrong" },
            })
          ).statusCode,
        ).toBe(401);
        const login = await app.inject({
          method: "POST",
          url: "/auth/password",
          headers: { origin: config.origin },
          payload: { username: "synthetic", password: "synthetic-password" },
        });
        expect(login.statusCode).toBe(200);
        expect(JSON.stringify(login.json())).not.toContain(
          "synthetic-password",
        );
      } finally {
        await app.close();
      }
    });
  },
);
