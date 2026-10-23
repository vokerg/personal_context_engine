import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, createTagRegistryRepository } from "@pce/db";
import { createApp } from "./app.js";
import { createSessionAuth, type SessionConfig } from "./session-auth.js";

const url = process.env.PCE_DB_TEST_URL;
const owner = "approval-http-" + randomUUID();
const config: SessionConfig = {
  mode: "dev-single-user",
  ownerSubject: owner,
  origin: "http://127.0.0.1:4310",
  issuer: "http://127.0.0.1:3110",
  audience: "http://127.0.0.1:3110/mcp",
  secure: false,
};

describe.skipIf(!url)("tag registry owner and session HTTP boundary", () => {
  let db: PrismaClient;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
  });
  afterAll(async () => {
    if (!db) return;
    await db.tagApproval.deleteMany({ where: { ownerSubject: owner } });
    await db.tagRegistryRevision.deleteMany({ where: { ownerSubject: owner } });
    await db.authSession.deleteMany({ where: { ownerSubject: owner } });
    await db.$disconnect();
  });

  it("requires explicit tags:write; forbids cookie CSRF bypass, malformed tags and foreign owner overrides", async () => {
    const auth = createSessionAuth(db, config);
    const app = createApp({
      config: {
        host: "127.0.0.1",
        port: 3110,
        environment: "test",
        corsOrigin: config.origin,
        requiresDatabase: false,
        auth: null,
      },
      dependencies: {
        sessionAuth: auth,
        tagRegistry: createTagRegistryRepository(db),
      },
    });
    try {
      expect((await app.inject("/api/v1/tag-registry")).statusCode).toBe(401);
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
      const issueGrant = async (scope: string) =>
        app.inject({
          method: "POST",
          url: "/auth/token",
          headers: { origin: config.origin, cookie, "x-pce-csrf": csrf },
          payload: { scope },
        });
      const readGrant = await issueGrant("notes:read");
      const writeGrant = await issueGrant("tags:write");
      expect(readGrant.statusCode).toBe(200);
      expect(writeGrant.statusCode).toBe(200);
      const readToken = readGrant.json().access_token as string;
      const writeToken = writeGrant.json().access_token as string;
      expect(
        (
          await app.inject({
            url: "/api/v1/tag-registry",
            headers: { authorization: "Bearer " + writeToken },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/tag-registry/demo",
            headers: { authorization: "Bearer " + readToken },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      for (const bad of [
        { url: "/api/v1/tag-registry/BAD", payload: {} },
        {
          url: "/api/v1/tag-registry/demo",
          payload: { ownerSubject: "foreign" },
        },
        { url: "/api/v1/tag-registry/demo", payload: { displayName: " " } },
      ]) {
        const response = await app.inject({
          method: "PUT",
          ...bad,
          headers: { authorization: "Bearer " + writeToken },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { code: "BAD_REQUEST" } });
      }
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/tag-registry/demo",
            headers: { cookie, origin: config.origin },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/v1/tag-registry/demo",
            headers: {
              cookie,
              origin: "https://evil.test",
              "x-pce-csrf": csrf,
            },
          })
        ).statusCode,
      ).toBe(403);
      const approved = await app.inject({
        method: "PUT",
        url: "/api/v1/tag-registry/demo",
        headers: { authorization: "Bearer " + writeToken },
        payload: {},
      });
      expect(approved.json()).toEqual({
        slug: "demo",
        approved: true,
        changed: true,
        revision: 1,
      });
      const replay = await app.inject({
        method: "PUT",
        url: "/api/v1/tag-registry/demo",
        headers: { authorization: "Bearer " + writeToken },
        payload: {},
      });
      expect(replay.json()).toMatchObject({ changed: false, revision: 1 });
      const list = await app.inject({
        url: "/api/v1/tag-registry",
        headers: { authorization: "Bearer " + readToken },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({
        revision: 1,
        approved: [{ slug: "demo", noteCount: 0 }],
        truncated: false,
      });
      expect(
        (
          await app.inject({
            url: "/api/v1/tag-registry?owner=other",
            headers: { authorization: "Bearer " + readToken },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/v1/tag-registry/demo",
            headers: { authorization: "Bearer " + writeToken },
          })
        ).json(),
      ).toEqual({
        slug: "demo",
        approved: false,
        changed: true,
        revision: 2,
      });
    } finally {
      await app.close();
    }
  });
  it("validates catalog pagination/search, rejects owner overrides and detects changed revisions", async () => {
    const app = createApp({
      config: {
        host: "127.0.0.1",
        port: 3110,
        environment: "test",
        corsOrigin: config.origin,
        requiresDatabase: false,
        auth: null,
      },
      dependencies: {
        sessionAuth: createSessionAuth(db, config),
        tagRegistry: createTagRegistryRepository(db),
      },
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/auth/dev-session",
        headers: { origin: config.origin },
        payload: {},
      });
      const cookie = login.cookies
        .map((c) => c.name + "=" + c.value)
        .join("; ");
      await db.tagApproval.createMany({
        data: Array.from({ length: 205 }, (_, i) => ({
          ownerSubject: owner,
          slug: "catalog-" + String(i).padStart(3, "0"),
        })),
        skipDuplicates: true,
      });
      const first = await app.inject({
        url: "/api/v1/tag-registry?limit=50&q=catalog",
        headers: { cookie },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().approved).toHaveLength(50);
      const second = await app.inject({
        url:
          "/api/v1/tag-registry?limit=50&q=catalog&after=" +
          first.json().nextCursor +
          "&revision=" +
          first.json().revision,
        headers: { cookie },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().approved[0].slug).toBe("catalog-050");
      for (const query of [
        "owner=someone",
        "after=catalog-049",
        "limit=201",
        "q=" + "x".repeat(101),
      ])
        expect(
          (
            await app.inject({
              url: "/api/v1/tag-registry?" + query,
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            url: "/api/v1/tag-registry?after=catalog-049&revision=999999",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            url: "/api/v1/tag-registry?q=catalog-204",
            headers: { cookie },
          })
        ).json().approved,
      ).toMatchObject([{ slug: "catalog-204" }]);
    } finally {
      await app.close();
    }
  });
});
