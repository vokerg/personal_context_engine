import { describe, expect, it, vi } from "vitest";
import { getNotes, getTags } from "./index.js";

describe("tag API client", () => {
  it("sends valid filters on the authenticated notes path", async () => {
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toContain("/api/v1/notes");
        expect(init?.method).toBe("GET");
        return new Response(JSON.stringify({ notes: [] }));
      },
    );
    const options = {
      baseUrl: "https://api.example",
      request,
      getAccessToken: () => "fake.jwt",
    };
    await expect(
      getNotes(options, {
        tag: "first-tag",
        project: "demo",
        kind: "memo",
        from: "2026-10-01",
        to: "2026-10-17",
      }),
    ).resolves.toEqual({ notes: [] });
    expect(request.mock.calls[0]?.[0].toString()).toBe(
      "https://api.example/api/v1/notes?tag=first-tag&project=demo&kind=memo&from=2026-10-01&to=2026-10-17",
    );
  });

  it("validates observed facets and sanitizes bad server data", async () => {
    const options = {
      baseUrl: "https://api.example",
      getAccessToken: () => "fake",
      request: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toContain("/api/v1/tags");
        expect(init?.method).toBe("GET");
        return new Response(
          JSON.stringify({
            tags: [{ slug: "first-tag", count: 2 }],
            truncated: false,
          }),
        );
      }),
    };
    await expect(getTags(options)).resolves.toEqual({
      tags: [{ slug: "first-tag", count: 2 }],
      truncated: false,
    });
    expect(options.request.mock.calls[0]?.[0].toString()).toBe(
      "https://api.example/api/v1/tags",
    );
    await expect(
      getTags({
        ...options,
        request: async () =>
          new Response(
            JSON.stringify({
              tags: [{ slug: "bad", count: 0 }],
              truncated: false,
            }),
          ),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects invalid filters before requesting a token", async () => {
    const getAccessToken = vi.fn(() => "fake");
    const request = vi.fn(async () => new Response("{}"));
    await expect(
      getNotes(
        { baseUrl: "https://api.example", getAccessToken, request },
        { tag: "not valid" },
      ),
    ).rejects.toThrow();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
