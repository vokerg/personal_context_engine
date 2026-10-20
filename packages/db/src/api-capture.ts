import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { parseNoteMarkdown } from "@pce/core";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class CaptureConflict extends Error {
  constructor() {
    super("Capture conflict");
    this.name = "CaptureConflict";
  }
}
export function createApiCaptureRepository(db: PrismaClient) {
  return {
    async persistByOwner(
      ownerSubject: string,
      input: { idempotencyKey: string; notes: string[] },
    ) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(ownerSubject) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey) ||
        !input.notes.length ||
        input.notes.length > 16 ||
        Buffer.byteLength(JSON.stringify(input.notes)) > 250_000
      )
        throw new TypeError("Invalid capture bounds");
      const notes = input.notes.map((markdown) => ({
        markdown,
        note: parseNoteMarkdown(markdown),
        revision: hash(markdown),
      }));
      if (new Set(notes.map((n) => n.note.metadata.id)).size !== notes.length)
        throw new CaptureConflict();
      const payloadHash = hash(JSON.stringify(input.notes)),
        idempotencyHash = hash(input.idempotencyKey);
      for (let attempt = 0; attempt < 6; attempt++)
        try {
          return await db.$transaction(
            async (tx) => {
              const existing = await tx.apiCaptureReceipt.findUnique({
                where: {
                  ownerSubject_idempotencyHash: {
                    ownerSubject,
                    idempotencyHash,
                  },
                },
              });
              if (existing) {
                if (existing.payloadHash !== payloadHash)
                  throw new CaptureConflict();
                return {
                  status: "DB_PERSISTED" as const,
                  noteIds: existing.noteIds,
                  indexing: "PENDING" as const,
                  replayed: true,
                };
              }
              const noteIds: string[] = [];
              for (const { note, revision } of notes) {
                const m = note.metadata;
                const current = await tx.note.findUnique({
                  where: { id: m.id },
                });
                if (current) {
                  if (
                    current.ownerSubject !== ownerSubject ||
                    current.contentHash !== revision ||
                    current.captureId !== m.capture_id
                  )
                    throw new CaptureConflict();
                } else {
                  const capture = await tx.capture.findUnique({
                    where: { id: m.capture_id },
                    include: { notes: { select: { ownerSubject: true } } },
                  });
                  if (capture) {
                    if (
                      !capture.notes.length ||
                      capture.notes.some(
                        (n) => n.ownerSubject !== ownerSubject,
                      ) ||
                      capture.capturedAtRaw !== m.captured_at ||
                      capture.source !== m.source ||
                      capture.timezone !== (m.timezone ?? null)
                    )
                      throw new CaptureConflict();
                  } else
                    await tx.capture.create({
                      data: {
                        id: m.capture_id,
                        capturedAt: new Date(m.captured_at),
                        capturedAtRaw: m.captured_at,
                        source: m.source,
                        timezone: m.timezone ?? null,
                        originalInput: note.originalInput,
                      },
                    });
                  await tx.note.create({
                    data: {
                      id: m.id,
                      ownerSubject,
                      captureId: m.capture_id,
                      schemaVersion: m.schema_version,
                      capturedAt: new Date(m.captured_at),
                      capturedAtRaw: m.captured_at,
                      source: m.source,
                      title: m.title,
                      kind: m.kind,
                      domains: m.domains,
                      projects: m.projects,
                      tags: m.tags,
                      relatedNoteIds: m.related_note_ids ?? [],
                      actionHint: m.action_hint,
                      reviewRequired: m.review_required,
                      occurredAt: m.occurred_at
                        ? new Date(m.occurred_at)
                        : null,
                      occurredAtRaw: m.occurred_at ?? null,
                      dueAt: m.due_at ? new Date(m.due_at) : null,
                      dueAtRaw: m.due_at ?? null,
                      timezone: m.timezone ?? null,
                      processingModel: m.processing_model ?? null,
                      summary: note.summary,
                      body: note.body,
                      originalInput: note.originalInput,
                      sourcePath: `api/${m.id}`,
                      sourceRevision: revision,
                      contentHash: revision,
                    },
                  });
                }
                await tx.dbProcessingJob.createMany({
                  data: [
                    {
                      ownerSubject,
                      noteId: m.id,
                      sourceRevision: current?.sourceRevision ?? revision,
                    },
                  ],
                  skipDuplicates: true,
                });
                noteIds.push(m.id);
              }
              await tx.apiCaptureReceipt.create({
                data: {
                  ownerSubject,
                  idempotencyHash,
                  payloadHash,
                  noteIds,
                  markdowns: input.notes,
                },
              });
              return {
                status: "DB_PERSISTED" as const,
                noteIds,
                indexing: "PENDING" as const,
                replayed: false,
              };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            ["P2002", "P2034"].includes(error.code) &&
            attempt < 5
          )
            continue;
          if (error instanceof Prisma.PrismaClientKnownRequestError)
            throw new CaptureConflict();
          throw error;
        }
      throw new CaptureConflict();
    },
  };
}
