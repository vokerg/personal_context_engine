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
    expect(serverFilters({ ...emptyFilters, status: "all" })).toEqual({
      status: "all",
    });
    expect(serverFilters({ ...emptyFilters, project: "bad slug" })).toBeNull();
    expect(
      readBrowseUrl(
        new URL("https://example.test/?owner=foreign&token=secret&q=private"),
      ),
    ).toEqual(emptyFilters);
    expect(readBrowseUrl(new URL("https://example.test/?status=all"))).toEqual({
      ...emptyFilters,
      status: "all",
    });
  });
});

it("converts local date bounds to exact DST instants without sharing query text", async () => {
  const { execFileSync } = await import("node:child_process");
  const script = `import { pagedFilters, emptyFilters } from './apps/web/src/browse.ts'; console.log(JSON.stringify(['2026-03-29','2026-10-25'].map(day => pagedFilters({...emptyFilters,from:day,to:day,query:'needle'}))));`;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, TZ: "Europe/Copenhagen" },
      encoding: "utf8",
    },
  );
  const rows = JSON.parse(output) as Array<{
    start: string;
    end: string;
    q: string;
  }>;
  expect(
    rows.map((row) => (Date.parse(row.end) - Date.parse(row.start)) / 3600000),
  ).toEqual([23, 25]);
  expect(rows[0]).toEqual({
    q: "needle",
    start: "2026-03-28T23:00:00.000Z",
    end: "2026-03-29T22:00:00.000Z",
  });
});
