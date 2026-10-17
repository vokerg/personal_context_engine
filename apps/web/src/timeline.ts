import type { NotePreview } from "@pce/api-client";

/** All filters operate on the notes returned by the current authenticated API.
 * The API does not yet expose a cursor or full-text search endpoint. */
export interface TimelineFilters {
  query: string;
  from: string;
  to: string;
}

export const PAGE_SIZE = 24;

/** Calendar day in the viewer's timezone (not the original ISO offset). */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function localDayKey(capturedAt: string, timeZone?: string): string {
  const key = timeZone ?? "__viewer_local__";
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
    dateFormatters.set(key, formatter);
  }
  const parts = formatter.formatToParts(new Date(capturedAt));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function filterTimeline(
  notes: readonly NotePreview[],
  filters: TimelineFilters,
  timeZone?: string,
): NotePreview[] {
  const query = filters.query.trim().normalize("NFKC").toLocaleLowerCase();
  return notes
    .filter((note) => {
      const day = localDayKey(note.capturedAt, timeZone);
      if (filters.from && day < filters.from) return false;
      if (filters.to && day > filters.to) return false;
      if (!query) return true;
      return `${note.title}\n${note.summary}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(query);
    })
    .sort(
      (a, b) =>
        Date.parse(b.capturedAt) - Date.parse(a.capturedAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

export interface DayGroup {
  day: string;
  notes: NotePreview[];
}

export function groupByLocalDay(
  notes: readonly NotePreview[],
  timeZone?: string,
): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const note of notes) {
    const day = localDayKey(note.capturedAt, timeZone);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.notes.push(note);
    else groups.push({ day, notes: [note] });
  }
  return groups;
}
