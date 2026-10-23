import { z } from "zod";
/** Same canonical UUID/ULID syntax as the public note ID contract. */
const NoteIdSchema = z
  .string()
  .regex(
    /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );

/** Research v1 is a separate JSON document. Never append it to Markdown v1. */
const Timestamp = z.string().datetime({ offset: true });
const BoundedText = z.string().trim().min(1);
const ClaimId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SourceId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const ExternalUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });

export const ResearchSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("external"),
      id: SourceId,
      url: ExternalUrl,
      title: z.string().max(300).nullable(),
      checkedAt: Timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pce_note"),
      id: SourceId,
      noteId: NoteIdSchema,
      sourceRevision: z.string().min(1).max(128).nullable(),
      rationale: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);

export const ResearchArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportId: NoteIdSchema,
    seriesId: NoteIdSchema,
    revision: z.number().int().min(1).max(10000),
    supersedesReportId: NoteIdSchema.nullable(),
    parentNoteId: NoteIdSchema,
    captureId: NoteIdSchema,
    title: BoundedText.max(200),
    question: BoundedText.max(2000),
    findings: BoundedText.max(150000),
    limitations: z.array(z.string().trim().min(1).max(2000)).max(30),
    researchedAt: Timestamp,
    status: z.enum(["COMPLETE", "DRAFT"]),
    provenance: z
      .object({
        agent: z.literal("chatgpt"),
        modelId: z.string().max(128).nullable(),
      })
      .strict(),
    pceRetrieval: z
      .object({
        outcome: z.enum([
          "searched",
          "no_related_notes_found",
          "PCE_CONTEXT_UNAVAILABLE",
        ]),
        queries: z.array(BoundedText.max(500)).min(1).max(8),
        checkedAt: Timestamp.nullable(),
        mode: z.enum(["lexical", "hybrid"]).nullable(),
        degradation: z.string().max(128).nullable(),
      })
      .strict(),
    sources: z.array(ResearchSourceSchema).max(100),
    claims: z
      .array(
        z
          .object({
            id: ClaimId,
            text: BoundedText.max(4000),
            classification: z.enum([
              "sourced_fact",
              "user_assertion",
              "analysis",
              "inference",
            ]),
            sourceIds: z.array(SourceId).max(20),
          })
          .strict(),
      )
      .max(150),
  })
  .strict()
  .superRefine((report, ctx) => {
    const problem = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if ((report.revision === 1) !== (report.supersedesReportId === null))
      problem(["supersedesReportId"], "Only revision 1 has no predecessor");
    if (report.revision === 1 && report.seriesId !== report.reportId)
      problem(["seriesId"], "First revision must establish its series ID");
    if (
      report.reportId === report.parentNoteId ||
      report.reportId === report.captureId
    )
      problem(
        ["reportId"],
        "Report and note/capture identities must be distinct",
      );
    if (
      report.pceRetrieval.outcome === "PCE_CONTEXT_UNAVAILABLE" &&
      report.status !== "DRAFT"
    )
      problem(["status"], "Unavailable PCE context cannot be marked complete");
    if (
      report.pceRetrieval.outcome !== "PCE_CONTEXT_UNAVAILABLE" &&
      !report.pceRetrieval.checkedAt
    )
      problem(
        ["pceRetrieval", "checkedAt"],
        "Actual PCE retrieval requires a checked-at time",
      );
    const ids = new Set(report.sources.map((source) => source.id));
    if (ids.size !== report.sources.length)
      problem(["sources"], "Duplicate source IDs");
    const claimIds = new Set(report.claims.map((claim) => claim.id));
    if (claimIds.size !== report.claims.length)
      problem(["claims"], "Duplicate claim IDs");
    const related = report.sources.filter(
      (source) => source.kind === "pce_note",
    );
    if (report.pceRetrieval.outcome === "searched" && related.length === 0)
      problem(
        ["sources"],
        "A successful related-note search needs verified PCE note evidence",
      );
    if (
      report.pceRetrieval.outcome === "no_related_notes_found" &&
      related.length
    )
      problem(["sources"], "No-matches status contradicts linked PCE notes");
    if (related.some((source) => source.noteId === report.parentNoteId))
      problem(
        ["sources"],
        "The newly captured parent note is not pre-existing evidence",
      );
    for (const [i, claim] of report.claims.entries()) {
      if (claim.classification === "sourced_fact" && !claim.sourceIds.length)
        problem(["claims", i, "sourceIds"], "Sourced facts require evidence");
      for (const id of claim.sourceIds)
        if (!ids.has(id))
          problem(["claims", i, "sourceIds"], "Unknown source ID");
    }
  });

export type ResearchArtifact = z.infer<typeof ResearchArtifactSchema>;

/** A single immutable revision; replay is identified by ID + content hash. */
export const ResearchSaveRequestSchema = z
  .object({
    artifact: ResearchArtifactSchema,
  })
  .strict()
  .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 250000);
export type ResearchSaveRequest = z.infer<typeof ResearchSaveRequestSchema>;

export const ResearchReceiptSchema = z
  .object({
    status: z.literal("DB_PERSISTED"),
    reportId: NoteIdSchema,
    parentNoteId: NoteIdSchema,
    revision: z.number().int().positive(),
    indexing: z.literal("NOT_INDEXED"),
    replayed: z.boolean(),
  })
  .strict();
export type ResearchReceipt = z.infer<typeof ResearchReceiptSchema>;

export const ResearchRecordSchema = ResearchArtifactSchema.safeExtend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.enum(["api", "github"]),
  savedAt: Timestamp,
  indexing: z.literal("NOT_INDEXED"),
});
export type ResearchRecord = z.infer<typeof ResearchRecordSchema>;
export const ResearchListSchema = z
  .object({
    reports: z.array(ResearchRecordSchema).max(100),
  })
  .strict();
