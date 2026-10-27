/** Inclusive device-local calendar dates; request builders own UTC conversion. */
export const datePresets = [
  { id: "today", label: "Today", days: 1 },
  { id: "week", label: "Week", days: 7 },
  { id: "month", label: "Month", days: 30 },
  { id: "year", label: "Year", days: 365 },
  { id: "all", label: "All", days: 0 },
] as const;
export type DatePreset = (typeof datePresets)[number]["id"];
export function localCalendarDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
export function presetDates(
  preset: DatePreset,
  now = new Date(),
): { from: string; to: string } {
  const days = datePresets.find((item) => item.id === preset)!.days;
  if (!days) return { from: "", to: "" };
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days + 1,
  );
  return { from: localCalendarDate(start), to: localCalendarDate(now) };
}
