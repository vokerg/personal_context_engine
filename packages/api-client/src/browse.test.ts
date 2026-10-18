import { expect, it, vi } from "vitest";
import { getBrowsePage, getBrowseFacets, ApiTransportError } from "./index.js";
import { BrowseQuerySchema, NoteDetailSchema } from "@pce/contracts";

it("rejects malformed browse queries before obtaining credentials", async () => {
  const getAccessToken = vi.fn(() => "synthetic-token");
  for (const query of [
    { q: "x".repeat(257) },
    { owner: "other" },
    { cursor: "bad.cursor" },
    { start: "bad" },
  ])
    expect(() =>
      getBrowsePage({ baseUrl: "https://api.example", getAccessToken }, query),
    ).toThrow();
  expect(getAccessToken).not.toHaveBeenCalled();
  expect(BrowseQuerySchema.safeParse({ q: "  needle  " }).data).toEqual({
    q: "needle",
  });
});
it("uses bounded typed pages and validates facets without dropping verified bearer transport", async () => {
  const calls: URL[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push(new URL(String(url)));
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer synthetic-token",
    );
    return new Response(
      JSON.stringify(
        calls.length === 1
          ? { notes: [], nextCursor: "opaque-cursor" }
          : {
              projects: [{ slug: "observed", count: 2 }],
              kinds: [{ slug: "memo", count: 2 }],
              truncated: false,
            },
      ),
    );
  };
  const options = {
    baseUrl: "https://api.example",
    getAccessToken: () => "synthetic-token",
    request,
  };
  expect(
    (await getBrowsePage(options, { q: "needle %_", project: "observed" }))
      .nextCursor,
  ).toBe("opaque-cursor");
  expect(calls[0]?.searchParams.get("q")).toBe("needle %_");
  expect((await getBrowseFacets(options)).projects[0]?.slug).toBe("observed");
  await expect(
    getBrowsePage({
      ...options,
      request: async () =>
        new Response(
          JSON.stringify({ notes: [], nextCursor: null, owner: "private" }),
        ),
    }),
  ).rejects.toBeInstanceOf(ApiTransportError);
});
it("structured details retain original offsets and reject hidden private adapter fields", () => {
  const note = {
    id: "01K00000000000000000000001",
    title: "Synthetic",
    summary: "Synthetic",
    capturedAt: "2026-10-18T08:00:00Z",
    body: "<script>literal</script>",
    originalInput: "Verbatim 🧪",
    metadata: {
      capturedAtRaw: "2026-10-18T10:00:00+02:00",
      source: "import",
      kind: "memo",
      domains: [],
      projects: [],
      actionHint: "none",
      reviewRequired: false,
      occurredAt: null,
      dueAt: null,
      timezone: "Europe/Copenhagen",
    },
  };
  expect(NoteDetailSchema.parse(note).metadata?.capturedAtRaw).toBe(
    note.metadata.capturedAtRaw,
  );
  expect(
    NoteDetailSchema.safeParse({
      ...note,
      metadata: { ...note.metadata, ownerSubject: "other" },
    }).success,
  ).toBe(false);
});
