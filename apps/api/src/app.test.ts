import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("API scaffold", () => {
  it("returns a validated public health response", async () => {
    const app = createApp();
    try {
      const response = await app.inject("/health");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
      expect((await app.inject("/api/v1/notes")).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
