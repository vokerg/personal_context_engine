import { describe, expect, it } from "vitest";
import type { NotePreview } from "@pce/api-client";
import {
  filterTimeline,
  groupByLocalDay,
  localDayKey,
  PAGE_SIZE,
} from "./timeline.js";

const id = (n: number) => String(n).padStart(26, "0");
const notes: NotePreview[] = [
  {
    id: id(1),
    title: "Morning note",
    summary: "Architecture notes from Prague",
    capturedAt: "2026-10-17T00:30:00+02:00",
  },
  {
    id: id(2),
    title: "Older idea",
    summary: "Searchable context",
    capturedAt: "2026-10-16T19:00:00+02:00",
  },
  {
    id: id(3),
    title: "Evening note",
    summary: "Design feedback",
    capturedAt: "2026-10-17T21:00:00+02:00",
  },
];

describe("local timeline", () => {
  it("groups near-midnight timestamps in the viewer's zone", () => {
    expect(localDayKey(notes[0].capturedAt, "Europe/Prague")).toBe(
      "2026-10-17",
    );
    expect(localDayKey(notes[0].capturedAt, "UTC")).toBe("2026-10-16");
  });

  it("combines normalized query and inclusive calendar dates and sorts newest first", () => {
    const result = filterTimeline(
      notes,
      { query: "  DESIGN  ", from: "2026-10-17", to: "2026-10-17" },
      "Europe/Prague",
    );
    expect(result.map((note) => note.id)).toEqual([id(3)]);
    const all = filterTimeline(
      notes,
      { query: "", from: "", to: "" },
      "Europe/Prague",
    );
    expect(all.map((note) => note.id)).toEqual([id(3), id(1), id(2)]);
    expect(
      groupByLocalDay(all, "Europe/Prague").map((group) => [
        group.day,
        group.notes.length,
      ]),
    ).toEqual([
      ["2026-10-17", 2],
      ["2026-10-16", 1],
    ]);
  });

  it("matches summary, avoids mutating API order and has bounded pages", () => {
    const copy = [...notes];
    expect(
      filterTimeline(notes, { query: "context", from: "", to: "" }).map(
        (note) => note.id,
      ),
    ).toEqual([id(2)]);
    expect(notes).toEqual(copy);
    expect(PAGE_SIZE).toBeGreaterThan(0);
    expect(PAGE_SIZE).toBeLessThanOrEqual(50);
  });
});
