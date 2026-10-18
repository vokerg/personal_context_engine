import { NotesQuerySchema, type NotesQuery } from "@pce/api-client";
import type { TimelineFilters } from "./timeline.js";

export type BrowseFilters = TimelineFilters & {
  tag: string;
  project: string;
  kind: NonNullable<NotesQuery["kind"]> | "";
};
export const emptyFilters: BrowseFilters = {
  query: "",
  from: "",
  to: "",
  tag: "",
  project: "",
  kind: "",
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
] as const;

/** Local dates stay in filterTimeline; API day boundaries are UTC. */
export function serverFilters(filters: BrowseFilters): NotesQuery | null {
  const result = NotesQuerySchema.safeParse({
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
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
  const parsed = NotesQuerySchema.safeParse(candidate);
  if (!parsed.success) return { ...emptyFilters };
  return {
    query: "",
    tag: parsed.data.tag ?? "",
    project: parsed.data.project ?? "",
    kind: parsed.data.kind ?? "",
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
    if (include && filters[key]) next.searchParams.set(key, filters[key]);
  }
  return next;
}
