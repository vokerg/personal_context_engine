import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  TASK_BATCH_MAX_BYTES,
  TaskExtractionBatchSchema,
  taskBatchPath,
  type TaskExtractionBatch,
  type TaskBatchReceipt,
} from "@pce/contracts";
import {
  createTaskRecords,
  taskTransaction,
  TaskConflict,
  TaskSourceUnavailable,
} from "./tasks.js";

export function createTaskExtractionRepository(db: PrismaClient) {
  async function persist(
    owner: string,
    raw: TaskExtractionBatch,
    origin: "api" | "github",
    sourcePath: string | null = null,
    sourceRevision: string | null = null,
  ): Promise<TaskBatchReceipt> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(owner))
      throw new TypeError("Invalid task owner");
    const batch = TaskExtractionBatchSchema.parse(raw);
    const canonical = JSON.stringify(batch);
    if (Buffer.byteLength(canonical, "utf8") > TASK_BATCH_MAX_BYTES)
      throw new TypeError("Task batch too large");
    const payloadHash = createHash("sha256").update(canonical).digest("hex");
    const receipt = (replayed: boolean): TaskBatchReceipt => ({
      status: "DB_PERSISTED",
      batchId: batch.batchId,
      taskIds: batch.tasks.map((t) => t.taskId),
      replayed,
      ...(batch.zeroTasksReason
        ? { zeroTasksReason: batch.zeroTasksReason }
        : {}),
    });
    return taskTransaction(db, async (tx) => {
      const existing = await tx.taskExtractionBatch.findFirst({
        where: { id: batch.batchId, ownerSubject: owner },
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new TaskConflict();
        return receipt(true);
      }
      if (
        await tx.taskExtractionBatch.count({
          where: {
            OR: [
              { id: batch.batchId },
              { ownerSubject: owner, captureId: batch.captureId },
            ],
          },
        })
      )
        throw new TaskConflict();
      const count = await tx.note.count({
        where: {
          id: { in: batch.sourceNoteIds },
          ownerSubject: owner,
          captureId: batch.captureId,
          removedAt: null,
        },
      });
      if (count !== batch.sourceNoteIds.length)
        throw new TaskSourceUnavailable();
      // Receipt, grounded source relationships, Task rows and CREATED events
      // commit together. A thrown later Task collision rolls back everything.
      await createTaskRecords(tx, owner, batch.tasks, origin);
      await tx.taskExtractionBatch.create({
        data: {
          id: batch.batchId,
          ownerSubject: owner,
          captureId: batch.captureId,
          payloadHash,
          artifact: batch,
          origin,
          sourcePath,
          sourceRevision,
        },
      });
      return receipt(false);
    });
  }
  return {
    persistByOwner: (owner: string, batch: TaskExtractionBatch) =>
      persist(owner, batch, "api"),
    async importByOwner(
      owner: string,
      content: string,
      path: string,
      revision: string,
    ) {
      if (
        Buffer.byteLength(content, "utf8") > TASK_BATCH_MAX_BYTES ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(revision)
      )
        throw new TypeError("Invalid task artifact");
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        throw new TypeError("Invalid task artifact");
      }
      const batch = TaskExtractionBatchSchema.parse(raw);
      if (path !== taskBatchPath(batch.batchId))
        throw new TypeError("Invalid task artifact path");
      return persist(owner, batch, "github", path, revision);
    },
  };
}
