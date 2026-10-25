import {
  ApiRequestError,
  type BrowseQuery,
  type SearchRequest,
} from "@pce/api-client";

export type Filters = {
  project: string;
  kind: string;
  tag: string;
  from: string;
  to: string;
};
export const emptyFilters: Filters = {
  project: "",
  kind: "",
  tag: "",
  from: "",
  to: "",
};
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function localMidnight(day: string, following = false): Date | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (
    year < 100 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    date < 1 ||
    date > 31
  )
    return null;
  const local = new Date(year, month - 1, date);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== date
  )
    return null;
  if (following) return new Date(year, month - 1, date + 1);
  return local;
}

/** Device-local inclusive calendar days translated to half-open UTC instants.
 * Construct each midnight separately so 23/25-hour DST days remain correct.
 */
export function localDateBounds(
  from: string,
  to: string,
): { start?: string; end?: string } {
  const start = from ? localMidnight(from) : null;
  const end = to ? localMidnight(to, true) : null;
  if ((from && !start) || (to && !end))
    throw new Error("Use valid dates in YYYY-MM-DD format.");
  if (from && to && from > to)
    throw new Error("Start date must not follow end date.");
  if (start && end && start.getTime() >= end.getTime())
    throw new Error("Invalid date range.");
  return {
    ...(start ? { start: start.toISOString() } : {}),
    ...(end ? { end: end.toISOString() } : {}),
  };
}

export function browseQuery(filters: Filters): BrowseQuery {
  return {
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.kind ? { kind: filters.kind as BrowseQuery["kind"] } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...localDateBounds(filters.from, filters.to),
  };
}
export function searchQuery(
  filters: Filters,
  query: string,
  cursor?: string,
): SearchRequest {
  if (!query.trim() || query.trim().length > 500)
    throw new Error("Enter a query of at most 500 characters.");
  const dates = localDateBounds(filters.from, filters.to);
  return {
    query: query.trim(),
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.kind ? { kind: filters.kind as SearchRequest["kind"] } : {}),
    ...(filters.tag ? { tags: [filters.tag] } : {}),
    ...dates,
    limit: 20,
    ...(cursor ? { cursor } : {}),
  };
}
export function localDayKey(timestamp: string): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
export function searchQuality(
  mode: "lexical" | "hybrid",
  degradation: string | null,
): string {
  if (mode === "hybrid" && !degradation)
    return "Hybrid: lexical and semantic retrieval";
  const reasons: Record<string, string> = {
    disabled: "semantic search disabled",
    unindexed: "semantic index incomplete",
    provider_unavailable: "semantic provider unavailable",
    budget_exhausted: "semantic budget exhausted",
  };
  return (
    "Lexical search" +
    (degradation
      ? " — " + (reasons[degradation] ?? "semantic search unavailable")
      : " — semantic search not used")
  );
}

export type FeedState<T> = {
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: unknown | null;
};
export type FeedPage<T> = { items: T[]; nextCursor: string | null };

/** Pure cancellation-aware cursor coordinator; instantiated once per query.
 * No note body, cursor or token is stored outside volatile memory.
 */
export class PagedFeed<T extends { id: string }> {
  private active: AbortController | null = null;
  private epoch = 0;
  private busy = false;
  private cursor: string | null | undefined = undefined;
  private seenIds = new Set<string>();
  private seenCursors = new Set<string>();
  private recoveredStaleCursor = false;
  readonly state: FeedState<T> = {
    items: [],
    nextCursor: null,
    loading: true,
    loadingMore: false,
    refreshing: false,
    error: null,
  };
  constructor(
    private readonly fetchPage: (
      cursor: string | undefined,
      signal: AbortSignal,
    ) => Promise<FeedPage<T>>,
    private readonly publish: (state: FeedState<T>) => void,
  ) {}

  private emit() {
    this.publish({ ...this.state, items: [...this.state.items] });
  }
  cancel() {
    this.epoch++;
    this.active?.abort();
    this.active = null;
    this.busy = false;
  }
  restart(keepVisible = false) {
    this.cancel();
    this.cursor = undefined;
    this.seenIds.clear();
    this.seenCursors.clear();
    this.recoveredStaleCursor = false;
    this.state.items = keepVisible ? this.state.items : [];
    this.state.loading = !keepVisible;
    this.state.refreshing = keepVisible;
    this.state.loadingMore = false;
    this.state.error = null;
    this.state.nextCursor = null;
    this.emit();
    void this.next(true);
  }
  loadMore() {
    if (!this.busy && !this.state.error && this.cursor) void this.next(false);
  }
  private async next(first: boolean) {
    if (this.busy) return;
    const epoch = this.epoch;
    const cursor = this.cursor;
    const controller = new AbortController();
    this.active = controller;
    this.busy = true;
    this.state.loadingMore = !first;
    this.state.error = null;
    this.emit();
    let recover = false;
    try {
      const page = await this.fetchPage(cursor, controller.signal);
      if (epoch !== this.epoch || controller.signal.aborted) return;
      if (
        page.nextCursor &&
        (page.nextCursor === cursor || this.seenCursors.has(page.nextCursor))
      )
        throw new Error("Repeated pagination cursor");
      if (cursor) this.seenCursors.add(cursor);
      if (first) {
        this.state.items = [];
        this.seenIds.clear();
      }
      for (const item of page.items) {
        if (!this.seenIds.has(item.id)) {
          this.seenIds.add(item.id);
          this.state.items.push(item);
        }
      }
      this.cursor = page.nextCursor;
      this.state.nextCursor = page.nextCursor;
    } catch (error) {
      if (epoch !== this.epoch || controller.signal.aborted) return;
      // A stale server-side cursor is not an empty page. Restart once,
      // invalidating all old pages rather than mixing two snapshots.
      if (
        !first &&
        error instanceof ApiRequestError &&
        error.status === 409 &&
        !this.recoveredStaleCursor
      ) {
        this.recoveredStaleCursor = true;
        this.cursor = undefined;
        this.state.items = [];
        this.state.nextCursor = null;
        this.seenIds.clear();
        this.seenCursors.clear();
        recover = true;
      } else {
        this.state.error = error;
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.active = null;
        this.state.loading = recover;
        this.state.loadingMore = false;
        this.state.refreshing = false;
        this.emit();
        if (recover) void this.next(true);
      }
    }
  }
}
