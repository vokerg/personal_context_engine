import {
  BrowseQuerySchema,
  BrowseStatusQuerySchema,
  type BrowseQuery,
  NotesQuerySchema,
  type NotesQuery,
  type BrowseStatus,
} from "@pce/api-client";
import type { TimelineFilters } from "./timeline.js";

export type BrowseFilters = TimelineFilters & {
  tag: string;
  project: string;
  kind: NonNullable<NotesQuery["kind"]> | "";
  status: BrowseStatus;
};
export const emptyFilters: BrowseFilters = {
  query: "",
  from: "",
  to: "",
  tag: "",
  project: "",
  kind: "",
  status: "active",
};
export const noteKinds = [
  "idea",
  "task",
  "memo",
  "thought",
  "decision",
  "reference",
] as const;
export const filterParameters = [
  "tag",
  "project",
  "kind",
  "from",
  "to",
  "status",
] as const;

/** Local dates stay in filterTimeline; API day boundaries are UTC. */
export function serverFilters(filters: BrowseFilters): NotesQuery | null {
  const result = NotesQuerySchema.safeParse({
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status !== "active" ? { status: filters.status } : {}),
  });
  return result.success ? result.data : null;
}

export function readBrowseUrl(url: URL): BrowseFilters {
  const candidate = Object.fromEntries(
    filterParameters.flatMap((key) => {
      const value = url.searchParams.get(key);
      return value ? [[key, value]] : [];
    }),
  );
  const legacyCandidate = Object.fromEntries(
    Object.entries(candidate).filter(([key]) => key !== "status"),
  );
  const parsed = NotesQuerySchema.safeParse(legacyCandidate);
  const parsedStatus = BrowseStatusQuerySchema.safeParse(
    candidate.status ? { status: candidate.status } : {},
  );
  if (!parsed.success || !parsedStatus.success) return { ...emptyFilters };
  return {
    query: "",
    tag: parsed.data.tag ?? "",
    project: parsed.data.project ?? "",
    kind: parsed.data.kind ?? "",
    status: parsedStatus.data.status ?? "active",
    from: parsed.data.from ?? "",
    to: parsed.data.to ?? "",
  };
}

/** Explicit opt-in only: never encode search text, credentials or note bodies. */
export function writeBrowseUrl(
  url: URL,
  filters: BrowseFilters,
  include: boolean,
): URL {
  const next = new URL(url);
  for (const key of filterParameters) {
    next.searchParams.delete(key);
    const value =
      key === "status" && filters.status === "active" ? "" : filters[key];
    if (include && value) next.searchParams.set(key, value);
  }
  return next;
}

/** Convert viewer-local calendar days to exact instants; end is exclusive.
 * Date.setDate handles 23/25-hour DST days without assuming a 24-hour duration. */
export function pagedFilters(filters: BrowseFilters): BrowseQuery | null {
  const start = filters.from ? new Date(filters.from + "T00:00:00") : null;
  const end = filters.to ? new Date(filters.to + "T00:00:00") : null;
  if (
    start &&
    (Number.isNaN(start.getTime()) || localDate(start) !== filters.from)
  )
    return null;
  if (end && (Number.isNaN(end.getTime()) || localDate(end) !== filters.to))
    return null;
  if (end) end.setDate(end.getDate() + 1);
  const parsed = BrowseQuerySchema.safeParse({
    ...(filters.query.trim() ? { q: filters.query.trim() } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status !== "active" ? { status: filters.status } : {}),
    ...(start ? { start: start.toISOString() } : {}),
    ...(end ? { end: end.toISOString() } : {}),
  });
  return parsed.success ? parsed.data : null;
}
function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
