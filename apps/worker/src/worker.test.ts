import { describe, expect, it } from "vitest";
import { workerStatus } from "./worker.js";

describe("worker scaffold", () => {
  it("stays inactive without an ingestion adapter", () => {
    expect(workerStatus()).toEqual({ state: "idle", imported: 0 });
  });
});
