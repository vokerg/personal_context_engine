import { expect, it, vi } from "vitest";
import { scheduleTagSnapshots } from "./tag-snapshot-schedule.js";

it("runs initially, then waits an hour after completion while DB cycles continue", async () => {
  let now = 0;
  const snapshot = vi.fn(async () => {});
  const prepare = vi.fn(async () => {});
  const scheduled = scheduleTagSnapshots(snapshot, () => now);
  for (let minute = 0; minute <= 60; minute++) {
    now = minute * 60_000;
    await prepare();
    await scheduled();
  }
  expect(prepare).toHaveBeenCalledTimes(61);
  expect(snapshot).toHaveBeenCalledTimes(2);
});

it("does not overlap and starts cooldown after a slow pass fails", async () => {
  let now = 0;
  let fail!: (error: Error) => void;
  const snapshot = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue(undefined);
  const scheduled = scheduleTagSnapshots(snapshot, () => now);
  const first = scheduled();
  now = 7_200_000;
  await scheduled();
  expect(snapshot).toHaveBeenCalledTimes(1);
  fail(new Error("unavailable"));
  await expect(first).rejects.toThrow("unavailable");
  now += 3_599_999;
  await scheduled();
  expect(snapshot).toHaveBeenCalledTimes(1);
  now++;
  await scheduled();
  expect(snapshot).toHaveBeenCalledTimes(2);
});
