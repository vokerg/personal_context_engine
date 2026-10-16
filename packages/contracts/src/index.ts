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

/** Synthetic read DTOs: IDs are canonical ULIDs or lowercase UUIDs only. */
export const NoteIdSchema = z
  .string()
  .regex(
    /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
export const NotePreviewSchema = z
  .object({
    id: NoteIdSchema,
    title: z.string().min(1).max(200),
    summary: z.string().min(1),
    capturedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type NotePreview = z.infer<typeof NotePreviewSchema>;

export const NoteDetailSchema = NotePreviewSchema.extend({
  body: z.string(),
}).strict();
export type NoteDetail = z.infer<typeof NoteDetailSchema>;

export const NotesListResponseSchema = z
  .object({
    notes: z.array(NotePreviewSchema),
  })
  .strict();
export type NotesListResponse = z.infer<typeof NotesListResponseSchema>;
