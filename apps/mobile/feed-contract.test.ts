import { describe, expect, it } from "vitest";
import { getBrowsePage, searchContext } from "@pce/api-client";
import { browseQuery, searchQuery } from "./feed-model";

const sampleId = "01K00000000000000000000001";
const filters = {
  project: "garden",
  kind: "memo",
  tag: "approved-tag",
  from: "2026-10-20",
  to: "2026-10-21",
};

describe("mobile filters through the real typed authenticated API client", () => {
  it("sends every timeline predicate and the pagination cursor to the server", async () => {
    let seen: URL | undefined;
    const request: typeof fetch = async (input, init) => {
      seen = new URL(String(input));
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer " + "A".repeat(64),
      );
      return new Response(
        JSON.stringify({
          notes: [
            {
              id: sampleId,
              title: "Synthetic memo",
              summary: "Synthetic preview",
              capturedAt: "2026-10-21T20:10:00Z",
            },
          ],
          nextCursor: "next_cursor_2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const result = await getBrowsePage(
      {
        baseUrl: "https://example.test",
        getAccessToken: () => "A".repeat(64),
        request,
      },
      { ...browseQuery(filters), cursor: "cursor_1" },
    );
    expect(result.notes.map((note) => note.id)).toEqual([sampleId]);
    expect(result.nextCursor).toBe("next_cursor_2");
    expect(seen?.pathname).toBe("/api/v1/browse");
    expect(seen?.searchParams.get("project")).toBe("garden");
    expect(seen?.searchParams.get("kind")).toBe("memo");
    expect(seen?.searchParams.get("tag")).toBe("approved-tag");
    expect(seen?.searchParams.get("start")).toContain("2026-10-20T");
    expect(seen?.searchParams.get("end")).toContain("2026-10-22T");
    expect(seen?.searchParams.get("cursor")).toBe("cursor_1");
  });

  it("POSTs conjunctive search filters and preserves lexical degradation from the API", async () => {
    let body: unknown;
    const request: typeof fetch = async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/api/v1/search");
      expect(init?.method).toBe("POST");
      body = JSON.parse(String(init?.body)) as unknown;
      return new Response(
        JSON.stringify({
          mode: "lexical",
          degradation: "provider_unavailable",
          results: [],
          nextCursor: null,
          truncated: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const results = await searchContext(
      {
        baseUrl: "https://example.test",
        getAccessToken: () => "A".repeat(64),
        request,
      },
      searchQuery(filters, "   WiFi plans   ", "search_cursor"),
    );
    expect(body).toMatchObject({
      query: "WiFi plans",
      tags: ["approved-tag"],
      project: "garden",
      kind: "memo",
      cursor: "search_cursor",
      limit: 20,
    });
    expect(results.results).toEqual([]);
    expect(results.mode).toBe("lexical");
    expect(results.degradation).toBe("provider_unavailable");
  });
});
