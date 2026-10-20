import { describe, expect, it, vi } from "vitest";
import { searchContext } from "./index.js";
describe("typed private search transport", () => {
  it("posts query bodies with bearer scope rather than putting private searches in URLs", async () => {
    const request = vi.fn(async (url, init) => {
      expect(new URL(url).pathname).toBe("/api/v1/search");
      expect(new URL(url).search).toBe("");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body).query).toBe("synthetic payment");
      expect(init.headers.Authorization).toBe("Bearer synthetic");
      return new Response(
        JSON.stringify({
          mode: "lexical",
          degradation: "disabled",
          results: [],
          nextCursor: null,
          truncated: false,
        }),
      );
    });
    expect(
      (
        await searchContext(
          {
            baseUrl: "http://127.0.0.1:3110",
            getAccessToken: () => "synthetic",
            request,
          },
          { query: "synthetic payment", limit: 20 },
        )
      ).results,
    ).toEqual([]);
  });
  it("keeps HttpOnly session cookies and session-bound CSRF separate from bearer transport", async () => {
    const request = vi.fn(async (_url, init) => {
      expect(init.credentials).toBe("include");
      expect(init.headers["X-PCE-CSRF"]).toBe("synthetic-csrf");
      expect(init.headers.Authorization).toBeUndefined();
      return new Response(
        JSON.stringify({
          mode: "lexical",
          degradation: "unindexed",
          results: [],
          nextCursor: null,
          truncated: false,
        }),
      );
    });
    await searchContext(
      {
        baseUrl: "http://127.0.0.1:3110",
        getAccessToken: () => null,
        useSessionCookie: true,
        getCsrfToken: () => "synthetic-csrf",
        request,
      },
      { query: "synthetic", limit: 20 },
    );
  });
});
