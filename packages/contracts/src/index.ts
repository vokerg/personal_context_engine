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
/** Markdown v1 tag and project slug syntax; never canonicalize user data. */
export const TagSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const NotePreviewSchema = z
  .object({
    id: NoteIdSchema,
    title: z.string().min(1).max(200),
    summary: z.string().min(1),
    tags: z.array(TagSlugSchema).optional(),
    capturedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type NotePreview = z.infer<typeof NotePreviewSchema>;

export const NoteDetailSchema = NotePreviewSchema.extend({
  body: z.string(),
  originalInput: z.string().optional(),
  metadata: z
    .object({
      capturedAtRaw: z.string().datetime({ offset: true }),
      source: z.enum([
        "chatgpt_text",
        "chatgpt_voice",
        "mobile_text",
        "mobile_voice",
        "import",
      ]),
      kind: z.enum([
        "idea",
        "task",
        "memo",
        "thought",
        "decision",
        "reference",
      ]),
      domains: z.array(TagSlugSchema).max(100),
      projects: z.array(TagSlugSchema).max(100),
      actionHint: z.enum(["none", "consider", "remind", "review", "follow_up"]),
      reviewRequired: z.boolean(),
      occurredAt: z.string().datetime({ offset: true }).nullable(),
      dueAt: z.string().datetime({ offset: true }).nullable(),
      timezone: z.string().max(128).nullable(),
    })
    .strict()
    .optional(),
}).strict();
export type NoteDetail = z.infer<typeof NoteDetailSchema>;

function validDateOnly(value: string): boolean {
  const day = new Date(value + "T00:00:00.000Z");
  return (
    !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value
  );
}

const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(validDateOnly);

const NoteKindFilterSchema = z.enum([
  "idea",
  "task",
  "memo",
  "thought",
  "decision",
  "reference",
]);

/** from/to bound inclusive UTC calendar days of the capture instant. */
export const NotesQuerySchema = z
  .object({
    tag: TagSlugSchema.optional(),
    project: TagSlugSchema.optional(),
    kind: NoteKindFilterSchema.optional(),
    from: DateOnlySchema.optional(),
    to: DateOnlySchema.optional(),
  })
  .strict()
  .refine(({ from, to }) => !from || !to || from <= to);
export type NotesQuery = z.infer<typeof NotesQuerySchema>;

const TagFacetSchema = z
  .object({
    slug: TagSlugSchema,
    count: z.number().int().positive().safe(),
  })
  .strict();

export const TagFacetsResponseSchema = z
  .object({
    tags: z.array(TagFacetSchema).max(200),
    truncated: z.boolean(),
  })
  .strict();
export type TagFacetsResponse = z.infer<typeof TagFacetsResponseSchema>;

export const NotesListResponseSchema = z
  .object({
    notes: z.array(NotePreviewSchema),
  })
  .strict();
export type NotesListResponse = z.infer<typeof NotesListResponseSchema>;

/** Opt-in local browsing; independent of the legacy list and future hybrid retrieval. */
export const BrowseQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(256).optional(),
    tag: TagSlugSchema.optional(),
    project: TagSlugSchema.optional(),
    kind: NoteKindFilterSchema.optional(),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
    cursor: z
      .string()
      .max(1200)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .refine(
    ({ start, end }) => !start || !end || Date.parse(start) < Date.parse(end),
  );
export type BrowseQuery = z.infer<typeof BrowseQuerySchema>;
export const BrowsePageSchema = z
  .object({
    notes: z
      .array(
        NotePreviewSchema.extend({
          summary: z.string().min(1).max(640),
          tags: z.array(TagSlugSchema).max(100).optional(),
        }),
      )
      .max(24),
    nextCursor: z
      .string()
      .max(1200)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
  })
  .strict();
export type BrowsePage = z.infer<typeof BrowsePageSchema>;
export const BrowseFacetsSchema = z
  .object({
    projects: z.array(TagFacetSchema).max(200),
    kinds: z
      .array(
        z
          .object({
            slug: NoteKindFilterSchema,
            count: z.number().int().positive().safe(),
          })
          .strict(),
      )
      .max(6),
    truncated: z.boolean(),
  })
  .strict();
export type BrowseFacets = z.infer<typeof BrowseFacetsSchema>;
