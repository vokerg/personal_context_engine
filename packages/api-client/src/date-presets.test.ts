import { afterEach, expect, it } from "vitest";
import { presetDates } from "./date-presets";
const original = process.env.TZ;
afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});
it("uses inclusive rolling local days across DST, month, leap-year and year boundaries", () => {
  process.env.TZ = "America/New_York";
  const now = new Date(2026, 2, 10, 23, 59);
  expect(presetDates("today", now)).toEqual({
    from: "2026-03-10",
    to: "2026-03-10",
  });
  expect(presetDates("week", now)).toEqual({
    from: "2026-03-04",
    to: "2026-03-10",
  });
  expect(presetDates("month", new Date(2024, 2, 1))).toEqual({
    from: "2024-02-01",
    to: "2024-03-01",
  });
  expect(presetDates("year", new Date(2025, 0, 1))).toEqual({
    from: "2024-01-03",
    to: "2025-01-01",
  });
  expect(presetDates("all", now)).toEqual({ from: "", to: "" });
});
