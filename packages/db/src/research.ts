import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ResearchArtifactSchema,
  ResearchSaveRequestSchema,
  ResearchRecordSchema,
  type ResearchArtifact,
  type ResearchReceipt,
  type ResearchRecord,
  type ResearchSaveRequest,
} from "@pce/contracts";

/** Safe outward error: never include private research text, sources or owner. */
export class ResearchConflict extends Error {
  constructor() {
    super("Research conflict");
    this.name = "ResearchConflict";
  }
}
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const validOwner = (owner: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(owner);
const validSourceRevision = (revision: string) =>
  /^[A-Za-z0-9_-]{1,128}$/.test(revision);

export function createResearchRepository(db: PrismaClient) {
  const toRecord = (row: {
    artifact: Prisma.JsonValue;
    contentHash: string;
    origin: string;
    createdAt: Date;
  }): ResearchRecord => ResearchRecordSchema.parse({
    ...ResearchArtifactSchema.parse(row.artifact),
    contentHash: row.contentHash,
    origin: row.origin,
    savedAt: row.createdAt.toISOString(),
    indexing: "NOT_INDEXED",
  });

  async function persist(
    owner: string,
    artifact: ResearchArtifact,
    origin: "api" | "github",
    sourcePath: string,
    sourceRevision: string,
  ): Promise<ResearchReceipt> {
    if (!validOwner(owner) || !validSourceRevision(sourceRevision))
      throw new TypeError("Invalid trusted research scope");
    const payload = ResearchArtifactSchema.parse(artifact);
    const contentHash = digest(JSON.stringify(payload));
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await db.$transaction(async (tx) => {
          const parent = await tx.note.findFirst({
            where: { id: payload.parentNoteId, ownerSubject: owner },
            select: { captureId: true },
          });
          if (!parent || parent.captureId !== payload.captureId)
            throw new ResearchConflict();

          const existing = await tx.researchReport.findUnique({
            where: { id: payload.reportId },
          });
          if (existing) {
            if (existing.ownerSubject !== owner ||
                existing.contentHash !== contentHash ||
                existing.sourcePath !== sourcePath ||
                existing.origin !== origin)
              throw new ResearchConflict();
            return {
              status: "DB_PERSISTED", reportId: existing.id,
              parentNoteId: existing.parentNoteId, revision: existing.revision,
              indexing: "NOT_INDEXED", replayed: true,
            } as const;
          }
          // Related notes are evidence only if they belong to this owner and
          // their stated revision is still current. No inferred associations.
          const related = payload.sources.filter((s) => s.kind === "pce_note");
          for (const citation of related) {
            const note = await tx.note.findFirst({
              where: { id: citation.noteId, ownerSubject: owner },
              select: { sourceRevision: true },
            });
            if (!note || (citation.sourceRevision !== null &&
              citation.sourceRevision !== note.sourceRevision))
              throw new ResearchConflict();
          }

          if (payload.revision > 1) {
            const predecessor = await tx.researchReport.findFirst({
              where: {
                id: payload.supersedesReportId!,
                ownerSubject: owner,
                parentNoteId: payload.parentNoteId,
                seriesId: payload.seriesId,
                revision: payload.revision - 1,
              },
              select: { id: true },
            });
            if (!predecessor) throw new ResearchConflict();
          } else if (payload.seriesId !== payload.reportId) {
            throw new ResearchConflict();
          }
          await tx.researchReport.create({
            data: {
              id: payload.reportId,
              ownerSubject: owner,
              parentNoteId: payload.parentNoteId,
              captureId: payload.captureId,
              seriesId: payload.seriesId,
              revision: payload.revision,
              supersedesReportId: payload.supersedesReportId,
              title: payload.title,
              researchedAt: new Date(payload.researchedAt),
              status: payload.status,
              contextOutcome: payload.pceRetrieval.outcome,
              artifact: payload as Prisma.InputJsonValue,
              contentHash,
              origin,
              sourcePath,
              sourceRevision,
            },
          });
          return {
            status: "DB_PERSISTED", reportId: payload.reportId,
            parentNoteId: payload.parentNoteId, revision: payload.revision,
            indexing: "NOT_INDEXED", replayed: false,
          } as const;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError &&
            ["P2002", "P2034"].includes(error.code) && attempt < 5)
          continue;
        if (error instanceof Prisma.PrismaClientKnownRequestError)
          throw new ResearchConflict();
        throw error;
      }
    }
    throw new ResearchConflict();
  }

  return {
    /** Client cannot set owner, origin, source path or saved-at timestamp. */
    persistByOwner(owner: string, input: ResearchSaveRequest) {
      const artifact = ResearchSaveRequestSchema.parse(input).artifact;
      const revision = digest(JSON.stringify(artifact));
      return persist(owner, artifact, "api", `api/research/${artifact.reportId}`, revision);
    },
    /** Trusted importer entrypoint only. Never expose client-selected paths. */
    importByOwner(owner: string, json: string, sourcePath: string, sourceRevision: string) {
      if (Buffer.byteLength(json, "utf8") > 250000)
        throw new TypeError("Research payload exceeds limit");
      let parsed: unknown;
      try {
        parsed = JSON.parse(json) as unknown;
      } catch {
        throw new TypeError("Invalid research JSON");
      }
      const artifact = ResearchArtifactSchema.parse(parsed);
      if (sourcePath !== `research/inbox/${artifact.reportId}.json`)
        throw new TypeError("Invalid research import path");
      return persist(owner, artifact, "github", sourcePath, sourceRevision);
    },
    async getByOwner(owner: string, id: string): Promise<ResearchRecord | null> {
      if (!validOwner(owner)) throw new TypeError("Invalid owner");
      const row = await db.researchReport.findFirst({
        where: { id, ownerSubject: owner },
      });
      return row ? toRecord(row) : null;
    },
    async listByNote(owner: string, parentNoteId: string): Promise<ResearchRecord[] | null> {
      if (!validOwner(owner)) throw new TypeError("Invalid owner");
      const note = await db.note.findFirst({
        where: { id: parentNoteId, ownerSubject: owner },
        select: { id: true },
      });
      if (!note) return null;
      const rows = await db.researchReport.findMany({
        where: { ownerSubject: owner, parentNoteId },
        orderBy: [{ researchedAt: "desc" }, { revision: "desc" }, { id: "asc" }],
        take: 100,
      });
      return rows.map(toRecord);
    },
  };
}
