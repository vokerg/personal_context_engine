import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@pce/api-client";
import {
  browseQuery,
  localDateBounds,
  localDayKey,
  PagedFeed,
  searchQuality,
  searchQuery,
  type FeedPage,
  type FeedState,
} from "./feed-model";

const id1 = "01K00000000000000000000001";
const id2 = "01K00000000000000000000002";
const id3 = "01K00000000000000000000003";
const filter = {
  project: "alpha",
  kind: "memo",
  tag: "approved",
  from: "2026-10-20",
  to: "2026-10-21",
};
afterEach(() => vi.restoreAllMocks());

describe("device-local day and server predicates", () => {
  it("builds inclusive local dates as half-open UTC bounds across spring DST", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(localDateBounds("2026-03-08", "2026-03-08")).toEqual({
        start: "2026-03-08T05:00:00.000Z",
        end: "2026-03-09T04:00:00.000Z",
      });
      expect(localDayKey("2026-03-09T03:00:00.000Z")).toBe("2026-03-08");
      expect(localDateBounds("2026-11-01", "2026-11-01")).toEqual({
        start: "2026-11-01T04:00:00.000Z",
        end: "2026-11-02T05:00:00.000Z",
      });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("rejects invalid, reversed, impossible and noncanonical dates", () => {
    for (const [from, to] of [
      ["2026-02-30", ""],
      ["2026-13-01", ""],
      ["2026-2-1", ""],
      ["2026-10-25", "2026-10-24"],
      ["2026-01-01", "not-a-date"],
    ])
      expect(() => localDateBounds(from, to)).toThrow();
  });

  it("combines project/kind/approved tag/date on server, never by slicing client pages", () => {
    const browse = browseQuery(filter);
    expect(browse).toMatchObject({
      project: "alpha",
      kind: "memo",
      tag: "approved",
    });
    expect(browse.start).toMatch(/^2026-10-20T/);
    expect(browse.end).toMatch(/^2026-10-22T/);
    const search = searchQuery(filter, "   home connection  ", "valid_CURSOR");
    expect(search).toMatchObject({
      query: "home connection",
      tags: ["approved"],
      project: "alpha",
      kind: "memo",
      limit: 20,
      cursor: "valid_CURSOR",
      start: browse.start,
      end: browse.end,
    });
    expect(() => searchQuery(filter, "  ")).toThrow();
  });
  it("does not label degraded retrieval as semantic success", () => {
    expect(searchQuality("hybrid", null)).toContain("semantic");
    expect(searchQuality("lexical", "provider_unavailable")).toContain(
      "provider unavailable",
    );
    expect(searchQuality("lexical", "budget_exhausted")).toContain(
      "budget exhausted",
    );
    expect(searchQuality("lexical", "disabled")).toContain("disabled");
  });
});

type Item = { id: string };
const page = (ids: string[], nextCursor: string | null): FeedPage<Item> => ({
  items: ids.map((id) => ({ id })),
  nextCursor,
});
function makeFeed(
  fetchPage: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<FeedPage<Item>>,
) {
  const snapshots: FeedState<Item>[] = [];
  const feed = new PagedFeed(fetchPage, (value) => snapshots.push(value));
  return { feed, snapshots, last: () => snapshots[snapshots.length - 1]! };
}
async function settled(condition: () => boolean) {
  await vi.waitFor(() => expect(condition()).toBe(true));
}

describe("paged native feed lifecycle", () => {
  it("walks all server cursors exactly once and suppresses duplicated note IDs", async () => {
    const calls: (string | undefined)[] = [];
    const { feed, last } = makeFeed(async (cursor) => {
      calls.push(cursor);
      return cursor === undefined
        ? page([id1, id2], "cursor_1")
        : page([id2, id3], null);
    });
    feed.restart();
    await settled(() => last().items.length === 2);
    feed.loadMore();
    feed.loadMore(); // concurrent events may not duplicate the page request
    await settled(() => last().items.length === 3);
    expect(last().items.map((x) => x.id)).toEqual([id1, id2, id3]);
    expect(last().nextCursor).toBeNull();
    expect(calls).toEqual([undefined, "cursor_1"]);
  });

  it("cancels stale responses on rapid filter/query changes or logout", async () => {
    let complete!: (value: FeedPage<Item>) => void;
    const old = makeFeed(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    old.feed.restart();
    old.feed.cancel(); // session logout or filter changed
    complete(page([id1], null));
    await Promise.resolve();
    expect(old.last().items).toEqual([]);
    const newer = makeFeed(async () => page([id2], null));
    newer.feed.restart();
    await settled(() => newer.last().items.length === 1);
    expect(newer.last().items[0]!.id).toBe(id2);
  });

  it("restarts once on a server-invalidated cursor rather than showing an empty page", async () => {
    const calls: (string | undefined)[] = [];
    const { feed, last } = makeFeed(async (cursor) => {
      calls.push(cursor);
      if (cursor === "stale") throw new ApiRequestError(400, "BAD_REQUEST");
      if (calls.length < 3) return page([id1], "stale");
      return page([id2], null);
    });
    feed.restart();
    await settled(() => last().items.length === 1);
    feed.loadMore();
    await settled(() => last().items[0]?.id === id2);
    expect(last().nextCursor).toBeNull();
    expect(calls).toEqual([undefined, "stale", undefined]);
  });

  it("stops on repeated cursors and permits explicit retry", async () => {
    const { feed, last } = makeFeed(async () => page([id1], "repeat"));
    feed.restart();
    await settled(() => last().items.length === 1);
    feed.loadMore();
    await settled(() => Boolean(last().error));
    expect(last().error).toBeInstanceOf(Error);
    expect(last().loadingMore).toBe(false);
    const count = last().items.length;
    feed.loadMore();
    expect(last().items.length).toBe(count);
    feed.restart();
    await settled(() => last().error === null && !last().loading);
  });

  it("retains an existing list while refreshing then replaces it on response", async () => {
    let call = 0;
    let finish!: (value: FeedPage<Item>) => void;
    const { feed, last } = makeFeed(async () => {
      if (++call === 1) return page([id1], null);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    feed.restart();
    await settled(() => last().items.length === 1);
    feed.restart(true);
    expect(last().refreshing).toBe(true);
    expect(last().items.map((n) => n.id)).toEqual([id1]);
    finish(page([id3], null));
    await settled(() => last().items[0]?.id === id3);
    expect(last().refreshing).toBe(false);
  });
});
