import { z } from "zod";
import { NoteIdSchema } from "./ids.js";

const text = z.string().refine((v) => !v.includes("\u0000"));
export const TaskIdSchema = NoteIdSchema;
export const TaskStatusSchema = z.enum(["OPEN", "COMPLETED"]);
export const TaskSourceSchema = z
  .object({
    noteId: NoteIdSchema,
    captureId: NoteIdSchema,
    evidence: z.string().min(1).max(2000).pipe(text).optional(),
  })
  .strict();
export const TaskCreateSchema = z
  .object({
    taskId: TaskIdSchema,
    title: z
      .string()
      .min(1)
      .max(200)
      .pipe(text)
      .refine((v) => v.trim().length > 0),
    description: z.string().min(1).max(8000).pipe(text).optional(),
    sources: z.array(TaskSourceSchema).max(20).default([]),
  })
  .strict()
  .refine(
    (v) => new Set(v.sources.map((s) => s.noteId)).size === v.sources.length,
  );
export const TaskSchema = z
  .object({
    taskId: TaskIdSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(8000).nullable(),
    status: TaskStatusSchema,
    revision: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    origin: z.enum(["api", "github"]),
    sources: z.array(TaskSourceSchema).max(20),
    unavailableSourceCount: z.number().int().nonnegative().max(20),
  })
  .strict();
export const TaskReceiptSchema = z
  .object({
    status: z.literal("DB_PERSISTED"),
    task: TaskSchema,
    replayed: z.boolean(),
  })
  .strict();
export const TaskListQuerySchema = z
  .object({
    status: TaskStatusSchema.or(z.literal("ALL")).default("OPEN"),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    after: TaskIdSchema.optional(),
  })
  .strict();
export const TaskPageSchema = z
  .object({
    tasks: z.array(TaskSchema).max(100),
    nextCursor: TaskIdSchema.nullable(),
  })
  .strict();
export const TaskMutationSchema = z
  .object({
    commandId: NoteIdSchema,
    expectedRevision: z.number().int().positive().max(2147483646),
    status: TaskStatusSchema,
  })
  .strict();
export const TaskMutationResponseSchema = z
  .object({
    task: TaskSchema,
    changed: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();
export const TaskEventSchema = z
  .object({
    revision: z.number().int().positive(),
    type: z.enum(["CREATED", "COMPLETED", "REOPENED"]),
    status: TaskStatusSchema,
    at: z.string().datetime({ offset: true }),
  })
  .strict();
export const TaskHistoryQuerySchema = z
  .object({
    afterRevision: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(2147483647)
      .default(0),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const TaskHistorySchema = z
  .object({
    events: z.array(TaskEventSchema).max(100),
    nextRevision: z.number().int().positive().nullable(),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;
export type TaskCreate = z.input<typeof TaskCreateSchema>;
export type TaskListQuery = z.input<typeof TaskListQuerySchema>;
export type TaskPage = z.infer<typeof TaskPageSchema>;
export type TaskMutation = z.infer<typeof TaskMutationSchema>;
export type TaskMutationResponse = z.infer<typeof TaskMutationResponseSchema>;
export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;
export type TaskHistoryQuery = z.input<typeof TaskHistoryQuerySchema>;
export type TaskHistory = z.infer<typeof TaskHistorySchema>;
