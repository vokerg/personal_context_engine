import { describe, expect, it } from "vitest";
import { canonicalNotePath, retryDelayMs, workerStatus } from "./worker.js";

describe("worker scaffold", () => {
  it("stays inactive without an ingestion adapter", () => {
    expect(workerStatus()).toEqual({ state: "idle", imported: 0 });
  });

  it("derives canonical date partitions from the captured offset, not UTC", () => {
    expect(canonicalNotePath("2026-10-15T00:30:00+14:00", "01K00000000000000000000001"))
      .toBe("notes/2026/10/01K00000000000000000000001.md");
  });

  it("caps exponential retries", () => {
    expect(retryDelayMs(1)).toBe(5000);
    expect(retryDelayMs(2)).toBe(10000);
    expect(retryDelayMs(100)).toBe(3600000);
  });
});
