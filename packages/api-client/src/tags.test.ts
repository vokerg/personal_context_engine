import { describe, expect, it, vi } from "vitest";
import { getNotes, getTags, removeNote, setNoteArchived } from "./index.js";

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
      "https://api.example/api/v1/tags?status=active",
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
    expect(() =>
      getNotes(
        { baseUrl: "https://api.example", getAccessToken, request },
        { tag: "not valid" },
      ),
    ).toThrow();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("sends an owner-scoped note removal without a request body", async () => {
    const noteId = "01K00000000000000000000001";
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toBe(
          "https://api.example/api/v1/notes/" + noteId,
        );
        expect(init?.method).toBe("DELETE");
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify({ removed: true }));
      },
    );
    await expect(
      removeNote(
        {
          baseUrl: "https://api.example",
          getAccessToken: () => "fake",
          request,
        },
        noteId,
      ),
    ).resolves.toEqual({ removed: true });
  });

  it("sends an owner-scoped archive toggle", async () => {
    const noteId = "01K00000000000000000000001";
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toBe(
          "https://api.example/api/v1/notes/" + noteId + "/archive",
        );
        expect(init?.method).toBe("PATCH");
        expect(init?.body).toBe(JSON.stringify({ archived: true }));
        return new Response(JSON.stringify({ status: "archived" }));
      },
    );
    await expect(
      setNoteArchived(
        {
          baseUrl: "https://api.example",
          getAccessToken: () => "fake",
          request,
        },
        noteId,
        true,
      ),
    ).resolves.toEqual({ status: "archived" });
  });
});
