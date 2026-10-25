import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskExtractionBatchSchema, taskBatchPath } from "@pce/contracts";
import {
  PrismaClient,
  createApiCaptureRepository,
  createTaskExtractionRepository,
  createTaskRepository,
} from "./index.js";

// Human-authored expected outputs, not a deterministic classifier or a model test.
const examples = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/task-policy-v1.json", import.meta.url),
    "utf8",
  ),
) as Array<{
  name: string;
  original: string;
  kind?: string;
  tasks: Array<{ title: string; evidence: string }>;
  skipBatch?: boolean;
  reason?: string;
}>;
describe.skipIf(!process.env.PCE_DB_TEST_URL)(
  "tasks-v1 supplied-output persistence matrix (no model inference)",
  () => {
    let db: PrismaClient;
    const owner = "policy-" + randomUUID(),
      ids: string[] = [],
      captures: string[] = [];
    beforeAll(async () => {
      db = new PrismaClient({
        datasources: { db: { url: process.env.PCE_DB_TEST_URL! } },
      });
      await db.$connect();
    });
    afterAll(async () => {
      if (!db) return;
      await db.taskCommand.deleteMany({ where: { ownerSubject: owner } });
      await db.taskEvent.deleteMany({ where: { ownerSubject: owner } });
      await db.taskSource.deleteMany({ where: { ownerSubject: owner } });
      await db.task.deleteMany({ where: { ownerSubject: owner } });
      await db.taskExtractionBatch.deleteMany({
        where: { ownerSubject: owner },
      });
      await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
      await db.note.deleteMany({ where: { id: { in: ids } } });
      await db.capture.deleteMany({ where: { id: { in: captures } } });
      await db.$disconnect();
    });
    it.each(examples)(
      "$name: preserves one original and supplied 0..N Task identities",
      async (example) => {
        const noteId = randomUUID(),
          captureId = randomUUID();
        ids.push(noteId);
        captures.push(captureId);
        const markdown = `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: 2026-10-25T12:00:00+01:00
source: import
kind: ${example.kind ?? "memo"}
domains: []
projects: []
tags: [task]
action_hint: none
review_required: ${example.reason ? "true" : "false"}
title: Synthetic policy example
---

# Synthetic policy example

## Summary

Synthetic human-authored expected extraction output, not model inference.

## Original input

${example.original}
`;
        const noteReceipt = await createApiCaptureRepository(db).persistByOwner(
          owner,
          { idempotencyKey: randomUUID(), notes: [markdown] },
        );
        expect(noteReceipt).toMatchObject({
          status: "DB_PERSISTED",
          noteIds: [noteId],
        });
        const original = await db.note.findUniqueOrThrow({
          where: { id: noteId },
        });
        expect(original.originalInput).toBe(example.original + "\n");
        expect(
          await db.task.count({
            where: { sources: { some: { noteId, ownerSubject: owner } } },
          }),
        ).toBe(0);
        const repo = createTaskExtractionRepository(db);
        const batch = TaskExtractionBatchSchema.parse({
          schemaVersion: 1,
          batchId: randomUUID(),
          captureId,
          sourceNoteIds: [noteId],
          classifier: {
            method: "explicit",
            policyVersion: "tasks-v1",
            agent: "Synthetic expected policy output",
          },
          tasks: example.tasks.map((task) => ({
            taskId: randomUUID(),
            title: task.title,
            sources: [{ noteId, captureId, evidence: task.evidence }],
          })),
          ...(example.reason ? { zeroTasksReason: example.reason } : {}),
        });
        if (!example.skipBatch) {
          const receipt = await repo.persistByOwner(owner, batch);
          expect(receipt.taskIds).toEqual(batch.tasks.map((t) => t.taskId));
          if (batch.tasks.length >= 3)
            await createTaskRepository(db).changeByOwner(
              owner,
              batch.tasks[1]!.taskId,
              {
                commandId: randomUUID(),
                expectedRevision: 1,
                status: "COMPLETED",
              },
            );
          expect(
            (
              await repo.importByOwner(
                owner,
                JSON.stringify(batch),
                taskBatchPath(batch.batchId),
                "synthetic-replay",
              )
            ).replayed,
          ).toBe(true);
          if (batch.tasks.length >= 3)
            expect(
              (await createTaskRepository(db).getByOwner(
                owner,
                batch.tasks[1]!.taskId,
              ))!.status,
            ).toBe("COMPLETED");
        }
        expect(
          await db.task.count({
            where: { ownerSubject: owner, sources: { some: { noteId } } },
          }),
        ).toBe(example.tasks.length);
        expect(
          await db.note.count({ where: { captureId, ownerSubject: owner } }),
        ).toBe(1);
        expect(await db.note.findUnique({ where: { id: noteId } })).toEqual(
          original,
        );
        if (example.skipBatch)
          expect(
            await db.taskExtractionBatch.count({
              where: { ownerSubject: owner, captureId },
            }),
          ).toBe(0);
      },
    );
  },
);
