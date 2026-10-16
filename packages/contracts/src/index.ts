import { z } from "zod";

/** Public liveness: does not inspect the database or reveal private state. */
export const HealthResponseSchema = z
  .object({ status: z.literal("ok") })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Readiness can fail without affecting process liveness. */
export const ReadyResponseSchema = z
  .object({ status: z.enum(["ready", "not_ready"]) })
  .strict();
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

export const ApiVersionResponseSchema = z
  .object({ version: z.literal("v1") })
  .strict();
export type ApiVersionResponse = z.infer<typeof ApiVersionResponseSchema>;

export const ApiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "BAD_REQUEST",
          "UNAUTHORIZED",
          "FORBIDDEN",
          "NOT_FOUND",
          "SERVICE_UNAVAILABLE",
          "INTERNAL_ERROR",
        ]),
      })
      .strict(),
  })
  .strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
