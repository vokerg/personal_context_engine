import { z } from "zod";
import { NoteIdSchema } from "./ids.js";
import { TaskCreateSchema, TaskReceiptSchema } from "./tasks.js";

export const SuggestedTaskSchema = z
  .object({
    taskId: NoteIdSchema,
    title: TaskCreateSchema.shape.title,
    description: z
      .string()
      .min(1)
      .max(8000)
      .refine((v) => !v.includes("\u0000"))
      .optional(),
    evidence: z
      .string()
      .min(1)
      .max(2000)
      .refine((v) => !v.includes("\u0000")),
  })
  .strict();
export const TaskSuggestionsSchema = z
  .object({
    noteId: NoteIdSchema,
    captureId: NoteIdSchema,
    model: z.string().min(1).max(100),
    tasks: z.array(SuggestedTaskSchema).max(20),
    reason: z.string().max(500),
  })
  .strict();
export const SaveSuggestedTasksSchema = z
  .object({
    captureId: NoteIdSchema,
    tasks: z.array(SuggestedTaskSchema).min(1).max(20),
  })
  .strict()
  .refine((v) => new Set(v.tasks.map((t) => t.taskId)).size === v.tasks.length);
export const SavedSuggestedTasksSchema = z
  .object({
    receipts: z.array(TaskReceiptSchema).min(1).max(20),
  })
  .strict();
export type SuggestedTask = z.infer<typeof SuggestedTaskSchema>;
export type TaskSuggestions = z.infer<typeof TaskSuggestionsSchema>;
export type SaveSuggestedTasks = z.infer<typeof SaveSuggestedTasksSchema>;

export const TaskSuggestionsConfigSchema = z
  .object({ enabled: z.boolean(), provider: z.literal("DeepSeek") })
  .strict();
