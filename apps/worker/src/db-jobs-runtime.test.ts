import { afterEach, expect, it, vi } from "vitest";
import { runEmbeddingLoop } from "./embedding-loop.js";
import {
  DB_JOBS_COOLDOWN_MS,
  withDbJobsConnection,
} from "./db-jobs-runtime.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function connection() {
  return {
    $connect: vi.fn(async () => {}),
    $disconnect: vi.fn(async () => {}),
  };
}

it("disconnects after a successful DB jobs pass", async () => {
  const db = connection();
  const pass = vi.fn(async () => {});
  await withDbJobsConnection(db, pass);
  expect(db.$connect).toHaveBeenCalledTimes(1);
  expect(pass).toHaveBeenCalledTimes(1);
  expect(db.$disconnect).toHaveBeenCalledTimes(1);
  expect(db.$connect.mock.invocationCallOrder[0]).toBeLessThan(
    pass.mock.invocationCallOrder[0],
  );
  expect(pass.mock.invocationCallOrder[0]).toBeLessThan(
    db.$disconnect.mock.invocationCallOrder[0],
  );
});

it("disconnects when processing fails, without swallowing its error", async () => {
  const db = connection();
  await expect(
    withDbJobsConnection(db, async () => {
      throw Error("processing failed");
    }),
  ).rejects.toThrow("processing failed");
  expect(db.$disconnect).toHaveBeenCalledTimes(1);
});

it("attempts to disconnect when the initial connection fails", async () => {
  const db = connection();
  db.$connect.mockRejectedValueOnce(Error("connection unavailable"));
  const pass = vi.fn(async () => {});
  await expect(withDbJobsConnection(db, pass)).rejects.toThrow(
    "connection unavailable",
  );
  expect(pass).not.toHaveBeenCalled();
  expect(db.$disconnect).toHaveBeenCalledTimes(1);
});

it("releases connections throughout the hourly cooldown and resumes processing", async () => {
  vi.useFakeTimers();
  const db = connection();
  const controller = new AbortController();
  const pass = vi.fn(async () => {
    if (pass.mock.calls.length === 2) controller.abort();
  });
  const running = runEmbeddingLoop(
    () => withDbJobsConnection(db, pass),
    controller.signal,
    DB_JOBS_COOLDOWN_MS,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(pass).toHaveBeenCalledTimes(1);
  expect(db.$disconnect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(DB_JOBS_COOLDOWN_MS - 1);
  expect(db.$connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(db.$connect).toHaveBeenCalledTimes(2);
  expect(db.$disconnect).toHaveBeenCalledTimes(2);
});
