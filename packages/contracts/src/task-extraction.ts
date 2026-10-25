import { z } from "zod";
import { NoteIdSchema } from "./ids.js";
import { TaskCreateSchema } from "./tasks.js";

/** Immutable complete extraction, separate from the Markdown v1 original. */
export const TaskExtractionBatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    batchId: NoteIdSchema,
    captureId: NoteIdSchema,
    sourceNoteIds: z.array(NoteIdSchema).min(1).max(20),
    classifier: z
      .object({
        method: z.enum(["llm", "explicit"]),
        policyVersion: z.literal("tasks-v1"),
        agent: z
          .string()
          .min(1)
          .max(120)
          .refine((v) => !v.includes("\u0000")),
        model: z
          .string()
          .min(1)
          .max(128)
          .refine((v) => !v.includes("\u0000"))
          .optional(),
      })
      .strict(),
    tasks: z.array(TaskCreateSchema).max(20),
    zeroTasksReason: z
      .string()
      .min(1)
      .max(500)
      .refine((v) => !v.includes("\u0000"))
      .optional(),
  })
  .strict()
  .superRefine((batch, ctx) => {
    const fail = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (new Set(batch.sourceNoteIds).size !== batch.sourceNoteIds.length)
      fail("Duplicate source");
    if (new Set(batch.tasks.map((t) => t.taskId)).size !== batch.tasks.length)
      fail("Duplicate task");
    if (batch.tasks.length && batch.zeroTasksReason)
      fail("Reason is only valid for zero tasks");
    for (const task of batch.tasks) {
      if (!task.sources.length) fail("Extracted tasks require source evidence");
      for (const source of task.sources)
        if (
          source.captureId !== batch.captureId ||
          !batch.sourceNoteIds.includes(source.noteId) ||
          !source.evidence?.trim()
        )
          fail("Unverified task source");
    }
  });
export const TaskBatchReceiptSchema = z
  .object({
    status: z.literal("DB_PERSISTED"),
    batchId: NoteIdSchema,
    taskIds: z.array(NoteIdSchema).max(20),
    replayed: z.boolean(),
    zeroTasksReason: z.string().max(500).optional(),
  })
  .strict();
export const TASK_BATCH_MAX_BYTES = 65536;
export const taskBatchPath = (id: string) =>
  `tasks/inbox/${NoteIdSchema.parse(id)}.json`;
export type TaskExtractionBatch = z.infer<typeof TaskExtractionBatchSchema>;
export type TaskBatchReceipt = z.infer<typeof TaskBatchReceiptSchema>;
