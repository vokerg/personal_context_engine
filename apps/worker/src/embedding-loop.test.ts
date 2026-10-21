import { afterEach, expect, it, vi } from "vitest";
import { runEmbeddingLoop } from "./embedding-loop.js";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("waits for the current pass and a full cooldown before starting another", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let finish!: () => void;
  const pass = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    )
    .mockImplementation(async () => {
      controller.abort();
    });
  const running = runEmbeddingLoop(pass, controller.signal);
  await vi.advanceTimersByTimeAsync(120000);
  expect(pass).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(59999);
  expect(pass).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(pass).toHaveBeenCalledTimes(2);
});
it("recovers from a failed cycle without logging private exception data", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const controller = new AbortController();
  const pass = vi
    .fn()
    .mockRejectedValueOnce(Error("private source credentials"))
    .mockImplementation(async () => {
      controller.abort();
    });
  const running = runEmbeddingLoop(pass, controller.signal);
  await vi.advanceTimersByTimeAsync(60000);
  await running;
  expect(pass).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(error.mock.calls)).not.toContain(
    "private source credentials",
  );
});
it("stops an idle wait immediately and rejects an unsafe cooldown", async () => {
  vi.useFakeTimers();
  const controller = new AbortController(),
    pass = vi.fn(async () => {});
  const running = runEmbeddingLoop(pass, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await running;
  await vi.advanceTimersByTimeAsync(120000);
  expect(pass).toHaveBeenCalledTimes(1);
  await expect(runEmbeddingLoop(pass, controller.signal, 1)).rejects.toThrow(
    "at least one minute",
  );
});
