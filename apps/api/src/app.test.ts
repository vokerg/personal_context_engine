import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadApiConfig } from "./config.js";

describe("public API boundary", () => {
  it("returns typed public endpoints and denies private notes", async () => {
    const app = createApp();
    try {
      expect((await app.inject("/health")).json()).toEqual({ status: "ok" });
      const ready = await app.inject("/ready");
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ready" });
      expect((await app.inject("/api/v1")).json()).toEqual({ version: "v1" });
      for (const path of [
        "/api/v1/notes",
        "/api/v1/notes/private-id",
        "/api/v1/research/reports",
        "/api/v1/research/reports/11111111-1111-4111-8111-111111111111",
        "/api/v1/notes/11111111-1111-4111-8111-111111111111/research",
      ]) {
        const response = await app.inject(path);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { code: "NOT_FOUND" } });
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      const healthHeaders = (await app.inject("/health")).headers;
      expect(healthHeaders["x-content-type-options"]).toBe("nosniff");
    } finally {
      await app.close();
    }
  });

  it("uses validated process environment in the default app factory", () => {
    const previous = process.env.API_REQUIRE_DB;
    process.env.API_REQUIRE_DB = "true";
    try {
      expect(() => createApp()).toThrow(/readiness adapter/);
    } finally {
      if (previous === undefined) delete process.env.API_REQUIRE_DB;
      else process.env.API_REQUIRE_DB = previous;
    }
  });

  it("fails closed when a configured database has no adapter", () => {
    const config = loadApiConfig({ API_REQUIRE_DB: "true" });
    expect(() => createApp({ config })).toThrow(/readiness adapter/);
  });

  it("separates failed readiness from liveness without leaks", async () => {
    const config = loadApiConfig({ API_REQUIRE_DB: "true" });
    const checkDatabase = async (): Promise<boolean> => {
      throw new Error("synthetic sensitive database connection string");
    };
    const app = createApp({ config, dependencies: { checkDatabase } });
    try {
      const health = await app.inject("/health");
      const ready = await app.inject("/ready");
      expect(health.statusCode).toBe(200);
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({ status: "not_ready" });
      expect(ready.body).not.toContain("sensitive");
    } finally {
      await app.close();
    }
  });

  it("uses an injected healthy dependency probe", async () => {
    const config = loadApiConfig({ API_REQUIRE_DB: "true" });
    let called = 0;
    const app = createApp({
      config,
      dependencies: {
        checkDatabase: async () => {
          called += 1;
          return true;
        },
      },
    });
    try {
      expect((await app.inject("/ready")).json()).toEqual({ status: "ready" });
      expect(called).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("normalizes exceptions without leaking details", async () => {
    const app = createApp();
    app.get("/synthetic-failure", async () => {
      throw new Error("synthetic-private-token");
    });
    try {
      const response = await app.inject("/synthetic-failure");
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: "INTERNAL_ERROR" } });
      expect(response.body).not.toContain("synthetic-private-token");
    } finally {
      await app.close();
    }
  });

  it("redacts invalid request bodies on schema errors", async () => {
    const app = createApp();
    app.post(
      "/synthetic-validated-input",
      {
        schema: {
          body: {
            type: "object",
            required: ["noteId"],
            properties: { noteId: { type: "string" } },
          },
        },
      },
      async () => ({ accepted: true }),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/synthetic-validated-input",
        payload: { noteId: 42, secret: "private-synthetic-value" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: "BAD_REQUEST" } });
      expect(response.body).not.toContain("private-synthetic-value");
    } finally {
      await app.close();
    }
  });

  it("allows configured CORS origins and GET preflights", async () => {
    const config = {
      ...loadApiConfig({ API_CORS_ORIGIN: "http://127.0.0.1:4200" }),
      corsOrigins: ["http://127.0.0.1:4200", "http://localhost:4200"],
    };
    const app = createApp({ config });
    try {
      const accepted = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://127.0.0.1:4200" },
      });
      expect(accepted.headers["access-control-allow-origin"]).toBe(
        "http://127.0.0.1:4200",
      );
      const localhost = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:4200" },
      });
      expect(localhost.headers["access-control-allow-origin"]).toBe(
        "http://localhost:4200",
      );
      const rejected = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://other.example" },
      });
      expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/api/v1",
        headers: {
          origin: "http://127.0.0.1:4200",
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.statusCode).toBe(204);
      const forbidden = await app.inject({
        method: "OPTIONS",
        url: "/api/v1",
        headers: {
          origin: "http://127.0.0.1:4200",
          "access-control-request-method": "POST",
        },
      });
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("closes cleanly and runs onClose hooks", async () => {
    const app = createApp();
    let closed = false;
    app.addHook("onClose", async () => {
      closed = true;
    });
    await app.ready();
    await app.close();
    expect(closed).toBe(true);
  });
});

import { createHmac } from "node:crypto";
import type { NoteDetail } from "@pce/contracts";
import {
  createHmacTokenVerifier,
  type AuthenticatedPrincipal,
} from "./auth.js";

const secret = "synthetic-test-key-32-bytes-minimum----";
const idAlice = "01K00000000000000000000001";
const idBob = "01K00000000000000000000002";
const auth = { issuer: "pce-test-issuer", audience: "pce-test-api", secret };

function signedToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: auth.issuer,
      aud: auth.audience,
      sub: "alice",
      scope: "notes:read",
      iat: now - 10,
      exp: now + 600,
      ...overrides,
    }),
  ).toString("base64url");
  const message = header + "." + claims;
  const signature = createHmac("sha256", secret)
    .update(message)
    .digest("base64url");
  return message + "." + signature;
}

describe("authenticated private read boundary", () => {
  const alice: NoteDetail = {
    id: idAlice,
    title: "Synthetic Alice",
    summary: "Sample A",
    body: "Synthetic content A",
    capturedAt: "2026-10-16T10:00:00+02:00",
  };
  const bob: NoteDetail = {
    id: idBob,
    title: "Synthetic Bob",
    summary: "Sample B",
    body: "Synthetic content B",
    capturedAt: "2026-10-16T10:00:00+02:00",
  };
  const fixtures: Record<string, NoteDetail[]> = { alice: [alice], bob: [bob] };
  const makeApp = () =>
    createApp({
      config: { ...loadApiConfig({}), auth },
      dependencies: {
        notes: {
          listByOwner: async (subject) =>
            fixtures[subject]?.map((note) => ({
              id: note.id,
              title: note.title,
              summary: note.summary,
              capturedAt: note.capturedAt,
            })) ?? [],
          getByOwner: async (subject, noteId) =>
            fixtures[subject]?.find((note) => note.id === noteId) ?? null,
        },
      },
    });

  it("cannot enable private routes without a verifier", () => {
    expect(() =>
      createApp({
        config: loadApiConfig({}),
        dependencies: {
          notes: { listByOwner: async () => [], getByOwner: async () => null },
        },
      }),
    ).toThrow(/authenticated token verifier/);
  });

  it("rejects missing, malformed, forged and expired credentials", async () => {
    const app = makeApp();
    try {
      const valid = signedToken();
      const parts = valid.split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({
          iss: auth.issuer,
          aud: auth.audience,
          sub: "bob",
          scope: "notes:read",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString("base64url");
      const forged = parts[0] + "." + forgedPayload + "." + parts[2];
      const attempts = [
        undefined,
        "Basic abc",
        "Bearer fake",
        "Bearer " + forged,
        "Bearer " + signedToken({ exp: 1 }),
        "Bearer " + signedToken({ aud: "another-api" }),
        "Bearer " + signedToken({ nbf: 4102444800 }),
        "Bearer " + signedToken({ iat: 1, exp: 4102444800 }),
      ];
      for (const authorization of attempts) {
        const response = await app.inject({
          url: "/api/v1/notes",
          ...(authorization ? { headers: { authorization } } : {}),
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: "UNAUTHORIZED" } });
        expect(response.body).not.toContain("Sample");
        expect(response.headers["www-authenticate"]).toBe("Bearer");
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    } finally {
      await app.close();
    }
  });

  it("enforces scope and masks other owners' IDs with 404", async () => {
    const app = makeApp();
    try {
      const noScope = await app.inject({
        url: "/api/v1/notes",
        headers: {
          authorization: "Bearer " + signedToken({ scope: "profile:read" }),
        },
      });
      expect(noScope.statusCode).toBe(403);
      expect(noScope.json()).toEqual({ error: { code: "FORBIDDEN" } });
      const aliceHeader = { authorization: "Bearer " + signedToken() };
      const list = await app.inject({
        url: "/api/v1/notes",
        headers: aliceHeader,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        notes: [
          {
            id: alice.id,
            title: alice.title,
            summary: alice.summary,
            capturedAt: alice.capturedAt,
          },
        ],
      });
      expect(list.body).not.toContain("Bob");
      const detail = await app.inject({
        url: "/api/v1/notes/" + idAlice,
        headers: aliceHeader,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual(alice);
      for (const otherId of [idBob, "invalid-path"]) {
        const other = await app.inject({
          url: "/api/v1/notes/" + otherId,
          headers: aliceHeader,
        });
        expect(other.statusCode).toBe(404);
        expect(other.json()).toEqual({ error: { code: "NOT_FOUND" } });
        expect(other.body).not.toContain("Bob");
      }
      const bobList = await app.inject({
        url: "/api/v1/notes",
        headers: { authorization: "Bearer " + signedToken({ sub: "bob" }) },
      });
      expect(
        bobList.json().notes.map((note: { id: string }) => note.id),
      ).toEqual([idBob]);
    } finally {
      await app.close();
    }
  });

  it("supports a replaceable verifier with no production credential in tests", async () => {
    const verifyToken = async (token: string) =>
      token === "fake"
        ? { subject: "fake-principal", scopes: ["notes:read"] }
        : null;
    const app = createApp({
      config: loadApiConfig({}),
      dependencies: {
        verifyToken,
        notes: {
          listByOwner: async () => [],
          getByOwner: async () => null,
        },
      },
    });
    try {
      expect(
        (
          await app.inject({
            url: "/api/v1/notes",
            headers: { authorization: "Bearer fake" },
          })
        ).json(),
      ).toEqual({ notes: [] });
    } finally {
      await app.close();
    }
  });

  it("fails closed when an injected verifier returns an invalid principal", async () => {
    const listByOwner = vi.fn(async () => []);
    const getByOwner = vi.fn(async () => null);
    let syntheticPrincipal: unknown = null;
    const app = createApp({
      config: loadApiConfig({}),
      dependencies: {
        verifyToken: async () =>
          syntheticPrincipal as AuthenticatedPrincipal | null,
        notes: { listByOwner, getByOwner },
      },
    });
    try {
      for (const invalidPrincipal of [
        { subject: "", scopes: ["notes:read"] },
        { subject: "alice\n", scopes: ["notes:read"] },
        { subject: "alice", scopes: null },
        { subject: "alice", scopes: ["notes:read", 3] },
      ]) {
        syntheticPrincipal = invalidPrincipal;
        for (const url of ["/api/v1/notes", "/api/v1/notes/" + idAlice]) {
          const response = await app.inject({
            url,
            headers: { authorization: "Bearer synthetic" },
          });
          expect(response.statusCode).toBe(401);
          expect(response.json()).toEqual({ error: { code: "UNAUTHORIZED" } });
        }
      }
      expect(listByOwner).not.toHaveBeenCalled();
      expect(getByOwner).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("verifier rejects algorithm confusion and tampering", async () => {
    const verify = createHmacTokenVerifier(auth);
    const token = signedToken();
    expect(await verify(token)).toMatchObject({ subject: "alice" });
    const unsignedHeader = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    expect(
      await verify(unsignedHeader + "." + token.split(".").slice(1).join(".")),
    ).toBeNull();
    expect(await verify(token + "extra")).toBeNull();
  });
});
