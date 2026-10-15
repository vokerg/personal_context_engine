import { z } from "zod";

/** Scaffold-only health contract; private note contracts follow in #9/#13. */
export const HealthResponseSchema = z
  .object({ status: z.literal("ok") })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
