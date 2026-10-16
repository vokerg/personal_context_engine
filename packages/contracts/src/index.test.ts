import { describe, expect, it } from "vitest";
import {
  ApiErrorResponseSchema,
  ApiVersionResponseSchema,
  HealthResponseSchema,
  ReadyResponseSchema,
} from "./index.js";

describe("public API wire contracts", () => {
  it("accepts liveness, readiness, version and error payloads", () => {
    expect(HealthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(ReadyResponseSchema.parse({ status: "not_ready" })).toEqual({
      status: "not_ready",
    });
    expect(ApiVersionResponseSchema.parse({ version: "v1" })).toEqual({
      version: "v1",
    });
    expect(
      ApiErrorResponseSchema.parse({ error: { code: "NOT_FOUND" } }),
    ).toEqual({ error: { code: "NOT_FOUND" } });
  });

  it("rejects unknown and privacy-sensitive response fields", () => {
    expect(
      HealthResponseSchema.safeParse({ status: "ok", token: "unexpected" }).success,
    ).toBe(false);
    expect(
      ReadyResponseSchema.safeParse({ status: "down", secret: "unexpected" })
        .success,
    ).toBe(false);
    expect(
      ApiErrorResponseSchema.safeParse({
        error: { code: "NOT_FOUND", detail: "private note text" },
      }).success,
    ).toBe(false);
  });
});
