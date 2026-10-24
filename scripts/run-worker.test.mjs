import { expect, it, vi } from "vitest";
import { runWorker } from "./run-worker.mjs";

it.each(["embeddings-once", "embeddings-loop", "db-jobs-once", "db-jobs-loop"])(
  "starts %s only after loading configuration and selecting the explicit mode",
  async (mode) => {
    const env = { WORKER_MODE: "idle", UNRELATED: "preserved" };
    const run = vi.fn(() => {
      expect(env).toEqual({ WORKER_MODE: mode, UNRELATED: "preserved" });
    });
    const loadEnvFile = vi.fn(() => {
      env.WORKER_MODE = "idle";
    });
    await runWorker(mode, { env, loadEnvFile, run });
    expect(loadEnvFile).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  },
);

it("refuses unknown modes and never starts work after configuration failure", async () => {
  const run = vi.fn();
  const loadEnvFile = vi.fn(() => {
    throw new Error("synthetic configuration failure");
  });
  await expect(runWorker("unknown", { run, loadEnvFile })).rejects.toThrow(
    "Invalid worker mode",
  );
  expect(loadEnvFile).not.toHaveBeenCalled();
  await expect(
    runWorker("db-jobs-once", { env: {}, run, loadEnvFile }),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
