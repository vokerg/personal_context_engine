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


// Owner-scoped approved vocabulary, separate from Markdown v1 note tags.
// Missing from this registry means "candidate", not an invalid tag.
export const ApprovedTagSchema = z.object({
  slug: TagSlugSchema,
  displayName: z.string().min(1).max(120).nullable(),
  description: z.string().max(500).nullable(),
  noteCount: z.number().int().nonnegative().safe(),
  approvedAt: z.string().datetime({ offset: true }),
}).strict();
export const TagRegistryResponseSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  approved: z.array(ApprovedTagSchema).max(200),
  truncated: z.boolean(),
}).strict();
export type TagRegistryResponse = z.infer<typeof TagRegistryResponseSchema>;

export const TagApprovalInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
}).strict();
export type TagApprovalInput = z.infer<typeof TagApprovalInputSchema>;
export const TagApprovalMutationResponseSchema = z.object({
  slug: TagSlugSchema,
  approved: z.boolean(),
  changed: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
}).strict();
export type TagApprovalMutationResponse = z.infer<typeof TagApprovalMutationResponseSchema>;

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

export const CaptureRequestSchema = z
  .object({
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    notes: z.array(z.string().min(1).max(250000)).min(1).max(16),
  })
  .strict()
  .refine(
    (v) => new TextEncoder().encode(JSON.stringify(v.notes)).length <= 250000,
  );
export const CaptureResponseSchema = z
  .object({
    status: z.literal("DB_PERSISTED"),
    noteIds: z.array(NoteIdSchema).min(1).max(16),
    indexing: z.literal("PENDING"),
    replayed: z.boolean(),
  })
  .strict();
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;
export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

export const SearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    tags: z.array(TagSlugSchema).max(10).optional(),
    project: TagSlugSchema.optional(),
    kind: NoteKindFilterSchema.optional(),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z
      .string()
      .max(1500)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .refine((v) => !v.start || !v.end || Date.parse(v.start) < Date.parse(v.end));
export const SearchResultSchema = z
  .object({
    id: NoteIdSchema,
    title: z.string().min(1).max(200),
    snippet: z.string().max(480),
    capturedAt: z.string().datetime({ offset: true }),
    sourceRevision: z.string().max(128),
    channel: z.enum(["github", "api", "other"]),
    tags: z.array(TagSlugSchema),
    projects: z.array(TagSlugSchema),
    kind: NoteKindFilterSchema,
    lexical: z.boolean(),
    semantic: z.boolean(),
  })
  .strict();
export const SearchResponseSchema = z
  .object({
    mode: z.enum(["lexical", "hybrid"]),
    degradation: z
      .enum([
        "disabled",
        "unindexed",
        "provider_unavailable",
        "budget_exhausted",
      ])
      .nullable(),
    results: z.array(SearchResultSchema).max(50),
    nextCursor: z.string().nullable(),
    truncated: z.boolean(),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** Explicit diagnostic call: no caller-selected owner, filters or pagination. */
export const DiagnoseSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    noteId: NoteIdSchema.optional(),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();
export type DiagnoseSearchRequest = z.infer<typeof DiagnoseSearchRequestSchema>;
