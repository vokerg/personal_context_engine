import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadApiConfig } from "./config.js";

function setup(enabled = true) {
  const pageByOwner = vi.fn(async (owner: string) => {
    if (owner === "badcursor") {
      const error = new Error("private cursor");
      error.name = "BrowseCursorError";
      throw error;
    }
    if (owner === "failure") throw Error("private data must not leak");
    return { notes: [], nextCursor: null };
  });
  const facetsByOwner = vi.fn(async () => ({
    projects: [],
    kinds: [],
    truncated: false,
  }));
  const app = createApp({
    config: loadApiConfig({}),
    dependencies: {
      verifyToken: async (token) => ({
        subject: token,
        scopes: token === "noscope" ? [] : ["notes:read"],
      }),
      notes: {
        listByOwner: async () => [],
        getByOwner: async () => null,
        ...(enabled ? { pageByOwner, facetsByOwner } : {}),
      },
    },
  });
  return { app, pageByOwner, facetsByOwner };
}
describe("gated local browse boundary", () => {
  it("keeps routes disabled until both trusted adapters are injected", async () => {
    const { app } = setup(false);
    try {
      for (const url of ["/api/v1/browse", "/api/v1/browse/facets"])
        expect((await app.inject(url)).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("checks identity/scope, validates strictly and derives owner only from the verified token", async () => {
    const { app, pageByOwner, facetsByOwner } = setup();
    try {
      expect((await app.inject("/api/v1/browse")).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: "/api/v1/browse",
            headers: { authorization: "Bearer noscope" },
          })
        ).statusCode,
      ).toBe(403);
      for (const query of [
        "owner=other",
        "limit=1000",
        "q=x&q=y",
        "q=" + "x".repeat(257),
        "start=bad",
        "start=2026-10-18T00:00:00Z&end=2026-10-17T00:00:00Z",
      ])
        expect(
          (
            await app.inject({
              url: "/api/v1/browse?" + query,
              headers: { authorization: "Bearer alice" },
            })
          ).statusCode,
        ).toBe(400);
      expect(pageByOwner).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            url: "/api/v1/browse?q=needle",
            headers: { authorization: "Bearer alice" },
          })
        ).statusCode,
      ).toBe(200);
      expect(pageByOwner).toHaveBeenCalledWith("alice", { q: "needle" });
      expect(
        (
          await app.inject({
            url: "/api/v1/browse/facets",
            headers: { authorization: "Bearer alice" },
          })
        ).statusCode,
      ).toBe(200);
      expect(facetsByOwner).toHaveBeenCalledWith("alice");
      expect(
        (
          await app.inject({
            url: "/api/v1/browse/facets?owner=other",
            headers: { authorization: "Bearer alice" },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("returns generic cursor/adapter failures with no private values", async () => {
    const { app } = setup();
    try {
      for (const [subject, status] of [
        ["badcursor", 400],
        ["failure", 500],
      ] as const) {
        const r = await app.inject({
          url: "/api/v1/browse",
          headers: { authorization: `Bearer ${subject}` },
        });
        expect(r.statusCode).toBe(status);
        expect(r.body).not.toContain("private");
      }
    } finally {
      await app.close();
    }
  });
});
