import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadApiConfig } from "./config.js";

describe("public API boundary", () => {
  it("returns typed operational responses without any private note route", async () => {
    const app = createApp();
    try {
      expect((await app.inject("/health")).json()).toEqual({ status: "ok" });
      const ready = await app.inject("/ready");
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ready" });
      expect((await app.inject("/api/v1")).json()).toEqual({ version: "v1" });
      for (const path of ["/api/v1/notes", "/api/v1/notes/private-id"]) {
        const response = await app.inject(path);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { code: "NOT_FOUND" } });
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect((await app.inject("/health")).headers["x-content-type-options"]).toBe(
        "nosniff",
      );
    } finally {
      await app.close();
    }
  });

  it("fails closed when a configured database has no adapter", () => {
    const config = loadApiConfig({ API_REQUIRE_DB: "true" });
    expect(() => createApp({ config })).toThrow(/readiness adapter/);
  });

  it("distinguishes failed readiness from liveness and hides dependency errors", async () => {
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

  it("reports healthy mandatory dependencies through an injected probe", async () => {
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

  it("normalizes unexpected exceptions without leaking their content", async () => {
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

  it("normalizes schema validation errors without echoing bad request bodies", async () => {
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

  it("allows only the explicitly configured CORS origin and GET preflights", async () => {
    const config = loadApiConfig({ API_CORS_ORIGIN: "http://127.0.0.1:4200" });
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
