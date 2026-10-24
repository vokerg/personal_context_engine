import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadApiConfig } from "./config.js";

const note = {
  id: "01K00000000000000000000001",
  title: "Synthetic title",
  summary: "Synthetic summary",
  capturedAt: "2026-10-16T10:00:00Z",
};

function makeApp() {
  const listByOwner = vi.fn(async () => [note]);
  const listTagsByOwner = vi.fn(async (subject: string) => ({
    tags: subject === "alice" ? [{ slug: "first-tag", count: 2 }] : [],
    truncated: false,
  }));
  const app = createApp({
    config: loadApiConfig({}),
    dependencies: {
      verifyToken: async (token) =>
        token === "alice" || token === "bob"
          ? { subject: token, scopes: ["notes:read"] }
          : token === "noscope"
            ? { subject: "alice", scopes: [] }
            : null,
      notes: { listByOwner, listTagsByOwner, getByOwner: async () => null },
    },
  });
  return { app, listByOwner, listTagsByOwner };
}

describe("observed tags and filtered notes boundary", () => {
  it("checks authentication/scope and passes only the verified owner", async () => {
    const { app, listTagsByOwner } = makeApp();
    try {
      expect((await app.inject("/api/v1/tags")).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: "/api/v1/tags",
            headers: { authorization: "Bearer noscope" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: "/api/v1/tags",
            headers: { authorization: "Bearer alice" },
          })
        ).json(),
      ).toEqual({
        tags: [{ slug: "first-tag", count: 2 }],
        truncated: false,
      });
      expect(
        (
          await app.inject({
            url: "/api/v1/tags",
            headers: { authorization: "Bearer bob" },
          })
        ).json(),
      ).toEqual({
        tags: [],
        truncated: false,
      });
      expect(listTagsByOwner.mock.calls).toEqual([["alice"], ["bob"]]);
    } finally {
      await app.close();
    }
  });

  it("validates mixed filters and never accepts caller-supplied subject", async () => {
    const { app, listByOwner } = makeApp();
    const headers = { authorization: "Bearer alice" };
    try {
      expect(
        (
          await app.inject({
            url: "/api/v1/notes?tag=first-tag&project=demo&kind=memo&from=2026-10-01&to=2026-10-17",
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(listByOwner).toHaveBeenCalledWith("alice", {
        tag: "first-tag",
        project: "demo",
        kind: "memo",
        from: "2026-10-01",
        to: "2026-10-17",
      });
      for (const query of [
        "?tag=CAPS",
        "?tag=bad%20slug",
        "?project=../evil",
        "?kind=unknown",
        "?from=2026-02-30",
        "?to=2026-13-01",
        "?from=2026-10-18&to=2026-10-17",
        "?subject=bob",
        "?tag=x&tag=y",
        "?tag=",
        "?tag=x&secret=never-echo",
      ]) {
        const response = await app.inject({
          url: "/api/v1/notes" + query,
          headers,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { code: "BAD_REQUEST" } });
        expect(response.body).not.toContain("never-echo");
      }
      expect(
        (
          await app.inject({
            url: "/api/v1/tags?owner=bob",
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(listByOwner).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("keeps tag route off without an adapter and redacts exceptions", async () => {
    const app = createApp({
      config: loadApiConfig({}),
      dependencies: {
        verifyToken: async () => ({
          subject: "alice",
          scopes: ["notes:read"],
        }),
        notes: { listByOwner: async () => [], getByOwner: async () => null },
      },
    });
    try {
      expect(
        (
          await app.inject({
            url: "/api/v1/tags",
            headers: { authorization: "Bearer valid" },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
    const broken = makeApp();
    broken.listTagsByOwner.mockRejectedValueOnce(
      new Error("private-synthetic-secret"),
    );
    try {
      const response = await broken.app.inject({
        url: "/api/v1/tags",
        headers: { authorization: "Bearer alice" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: { code: "INTERNAL_ERROR" } });
      expect(response.body).not.toContain("private-synthetic-secret");
    } finally {
      await broken.app.close();
    }
  });
});
