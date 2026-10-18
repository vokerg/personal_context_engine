import { describe, expect, it } from "vitest";
import {
  emptyFilters,
  readBrowseUrl,
  serverFilters,
  writeBrowseUrl,
} from "./browse.js";

describe("filter navigation privacy and validation", () => {
  it("only shares explicit structured filters, keeping query text out of URLs", () => {
    const filters = {
      ...emptyFilters,
      query: "synthetic private phrase",
      tag: "focus",
      project: "demo",
      kind: "memo" as const,
      from: "2026-10-01",
      to: "2026-10-17",
    };
    const url = new URL(
      "https://example.test/?note=01K00000000000000000000001",
    );
    expect(writeBrowseUrl(url, filters, false).searchParams.has("tag")).toBe(
      false,
    );
    const shared = writeBrowseUrl(url, filters, true);
    expect(shared.searchParams.get("tag")).toBe("focus");
    expect(shared.href).not.toContain("phrase");
    expect(readBrowseUrl(shared)).toEqual({ ...filters, query: "" });
    expect(
      writeBrowseUrl(shared, filters, false).searchParams.get("note"),
    ).toBe(url.searchParams.get("note"));
    expect(writeBrowseUrl(shared, filters, false).searchParams.has("tag")).toBe(
      false,
    );
  });
  it("rejects invalid URL filters and excludes local-calendar dates from UTC API filters", () => {
    for (const params of [
      "tag=Bad",
      "project=../bad",
      "kind=bad",
      "from=2026-02-30",
      "from=2026-10-18&to=2026-10-01",
    ]) {
      expect(readBrowseUrl(new URL("https://example.test/?" + params))).toEqual(
        emptyFilters,
      );
    }
    expect(
      serverFilters({ ...emptyFilters, tag: "focus", from: "2026-10-17" }),
    ).toEqual({ tag: "focus" });
    expect(serverFilters({ ...emptyFilters, project: "bad slug" })).toBeNull();
    expect(
      readBrowseUrl(
        new URL("https://example.test/?owner=foreign&token=secret&q=private"),
      ),
    ).toEqual(emptyFilters);
  });
});
