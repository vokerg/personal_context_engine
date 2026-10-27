import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  createNoteRepository,
  createTaskExtractionRepository,
  createTaskRepository,
} from "@pce/db";
import { taskBatchPath, type TaskExtractionBatch } from "@pce/contracts";
import {
  runTaskImportPass,
  taskIngressCheckpointKey,
  taskIngressConfig,
} from "./task-ingress.js";
import type { TaskIngressStore } from "./content-store/port.js";

describe("independent task import configuration", () => {
  it("requires its own opt-in and validates private-reader configuration", () => {
    expect(
      taskIngressConfig({ PCE_RESEARCH_INGRESS_ENABLED: "true" }),
    ).toBeNull();
    expect(taskIngressConfig({})).toBeNull();
    expect(() =>
      taskIngressConfig({ PCE_TASK_INGRESS_ENABLED: "yes" }),
    ).toThrow();
    expect(() =>
      taskIngressConfig({ PCE_TASK_INGRESS_ENABLED: "true" }),
    ).toThrow();
    expect(
      taskIngressConfig({
        PCE_TASK_INGRESS_ENABLED: "true",
        PCE_TASK_INGRESS_REPOSITORY: "synthetic/private",
        PCE_TASK_INGRESS_BRANCH: "main",
        PCE_TASK_INGRESS_TOKEN: "synthetic",
      }),
    ).toEqual({
      repository: "synthetic/private",
      branch: "main",
      token: "synthetic",
    });
  });
});
describe.skipIf(!process.env.PCE_DB_TEST_URL)(
  "task extraction dual ingress and durable recovery",
  () => {
    let db: PrismaClient;
    const owner = "batch-" + randomUUID(),
      foreign = "foreign-" + randomUUID();
    const noteIds: string[] = [],
      captureIds: string[] = [],
      keys: string[] = [];
    const fixtures = (count: number) => {
      const noteId = randomUUID(),
        captureId = randomUUID(),
        batchId = randomUUID();
      noteIds.push(noteId);
      captureIds.push(captureId);
      const actions = [
        "Buy synthetic filters",
        "Email synthetic landlord",
        "Check synthetic invoice",
      ];
      const original = actions.join("; ");
      const batch: TaskExtractionBatch = {
        schemaVersion: 1,
        batchId,
        captureId,
        sourceNoteIds: [noteId],
        classifier: {
          method: "llm",
          policyVersion: "tasks-v1",
          agent: "Synthetic classifier",
        },
        tasks: actions.slice(0, count).map((title) => ({
          taskId: randomUUID(),
          title,
          sources: [{ noteId, captureId, evidence: title }],
        })),
      };
      const markdown = `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: 2026-10-25T09:00:00+01:00
source: import
kind: memo
domains: []
projects: []
tags: []
action_hint: none
review_required: false
title: Synthetic batch source
---

# Synthetic batch source

## Summary

Synthetic batch source.

## Original input

${original}
`;
      return { noteId, captureId, batch, markdown, original };
    };
    const importNote = (f: ReturnType<typeof fixtures>) =>
      createNoteRepository(db).importMarkdown({
        ownerSubject: owner,
        sourcePath: `inbox/2026-10-25_${f.noteId}.md`,
        sourceRevision: "synthetic-note-revision",
        markdown: f.markdown,
      });
    const checkpoint = () => {
      const key = taskIngressCheckpointKey(
        owner,
        "synthetic/private-" + randomUUID(),
        "main",
      );
      keys.push(key);
      return key;
    };
    beforeAll(async () => {
      db = new PrismaClient({
        datasources: { db: { url: process.env.PCE_DB_TEST_URL! } },
      });
      await db.$connect();
    });
    afterAll(async () => {
      if (!db) return;
      await db.taskIngressAttempt.deleteMany({
        where: { ownerSubject: owner },
      });
      await db.ingestionCheckpoint.deleteMany({ where: { key: { in: keys } } });
      await db.taskExtractionBatch.deleteMany({
        where: { ownerSubject: { in: [owner, foreign] } },
      });
      await db.taskCommand.deleteMany({ where: { ownerSubject: owner } });
      await db.taskEvent.deleteMany({ where: { ownerSubject: owner } });
      await db.taskSource.deleteMany({ where: { ownerSubject: owner } });
      await db.task.deleteMany({ where: { ownerSubject: owner } });
      await db.note.deleteMany({ where: { id: { in: noteIds } } });
      await db.capture.deleteMany({ where: { id: { in: captureIds } } });
      await db.$disconnect();
    });
    it("durably defers an early artifact, resumes after Note import/restart, and never reopens completed task 2", async () => {
      const f = fixtures(3),
        path = taskBatchPath(f.batch.batchId),
        key = checkpoint();
      const store: TaskIngressStore = {
        listTaskBatches: async () => ({
          files: [{ path, revision: "batch-revision" }],
        }),
        readTaskBatch: async () => ({
          path,
          revision: "batch-revision",
          content: JSON.stringify(f.batch),
        }),
      };
      let now = new Date("2026-10-25T10:00:00Z");
      const run = () =>
        runTaskImportPass({
          db,
          store,
          ownerSubject: owner,
          checkpointKey: key,
          now: () => now,
        });
      expect(await run()).toMatchObject({ deferred: 1, imported: 0 });
      expect(
        await db.taskIngressAttempt.findFirst({
          where: { checkpointKey: key },
        }),
      ).toMatchObject({
        status: "RETRY",
        lastErrorCode: "DEPENDENCY_OR_SOURCE_UNAVAILABLE",
      });
      expect(
        await db.taskExtractionBatch.count({ where: { id: f.batch.batchId } }),
      ).toBe(0);
      await importNote(f);
      const original = await db.note.findUniqueOrThrow({
        where: { id: f.noteId },
      });
      // The durable backoff survives the next pass (no in-memory queue).
      expect(await run()).toMatchObject({ deferred: 1, imported: 0 });
      now = new Date(now.getTime() + 60000);
      expect(await run()).toMatchObject({ imported: 1, deferred: 0 });
      expect(
        await db.task.count({
          where: {
            ownerSubject: owner,
            sources: { some: { noteId: f.noteId } },
          },
        }),
      ).toBe(3);
      const second = f.batch.tasks[1]!.taskId;
      await createTaskRepository(db).changeByOwner(owner, second, {
        commandId: randomUUID(),
        expectedRevision: 1,
        status: "COMPLETED",
      });
      // Direct API replay converges with GitHub import; it does not change origin/state.
      expect(
        await createTaskExtractionRepository(db).persistByOwner(owner, f.batch),
      ).toMatchObject({
        replayed: true,
        taskIds: f.batch.tasks.map((t) => t.taskId),
      });
      expect(await run()).toMatchObject({ replayed: 1 });
      expect(
        (await createTaskRepository(db).getByOwner(owner, second))!.status,
      ).toBe("COMPLETED");
      expect(await db.note.findUnique({ where: { id: f.noteId } })).toEqual(
        original,
      );
      expect(
        await db.taskIngressAttempt.findFirst({
          where: { checkpointKey: key },
        }),
      ).toMatchObject({ status: "IMPORTED" });
    });
    it("supports zero tasks and note-only partial capture followed by safe batch retry", async () => {
      const f = fixtures(0);
      f.batch.zeroTasksReason = "No clear commitment";
      await importNote(f);
      expect(
        await db.taskExtractionBatch.count({ where: { id: f.batch.batchId } }),
      ).toBe(0);
      expect(
        await createTaskExtractionRepository(db).persistByOwner(owner, f.batch),
      ).toMatchObject({
        taskIds: [],
        replayed: false,
        zeroTasksReason: "No clear commitment",
      });
      expect(
        await createTaskExtractionRepository(db).importByOwner(
          owner,
          JSON.stringify(f.batch),
          taskBatchPath(f.batch.batchId),
          "later-commit",
        ),
      ).toMatchObject({ replayed: true, taskIds: [] });
    });
    it("rolls back a later task collision, rejects foreign sources and changed/replacement batches", async () => {
      const f = fixtures(3);
      await importNote(f);
      const repo = createTaskExtractionRepository(db);
      const conflicting = f.batch.tasks[2]!;
      await createTaskRepository(db).createByOwner(owner, {
        ...conflicting,
        title: "Different independent intent",
      });
      await expect(repo.persistByOwner(owner, f.batch)).rejects.toMatchObject({
        name: "TaskConflict",
      });
      expect(
        await db.task.count({ where: { id: f.batch.tasks[0]!.taskId } }),
      ).toBe(0);
      expect(
        await db.taskExtractionBatch.count({ where: { id: f.batch.batchId } }),
      ).toBe(0);
      const fresh = fixtures(1);
      await importNote(fresh);
      await expect(
        repo.persistByOwner(foreign, fresh.batch),
      ).rejects.toMatchObject({ name: "TaskSourceUnavailable" });
      await repo.persistByOwner(owner, fresh.batch);
      await expect(
        repo.persistByOwner(owner, { ...fresh.batch, tasks: [] }),
      ).rejects.toMatchObject({ name: "TaskConflict" });
      await expect(
        repo.persistByOwner(owner, { ...fresh.batch, batchId: randomUUID() }),
      ).rejects.toMatchObject({ name: "TaskConflict" });
      await expect(
        repo.importByOwner(
          owner,
          JSON.stringify(fresh.batch),
          "tasks/inbox/../README.md",
          "changed",
        ),
      ).rejects.toBeInstanceOf(TypeError);
    });
    it("retains malformed artifacts as terminal observations while advancing/rescanning healthy pages", async () => {
      const f = fixtures(1);
      await importNote(f);
      const good = taskBatchPath(f.batch.batchId),
        bad = taskBatchPath(randomUUID()),
        key = checkpoint();
      const store: TaskIngressStore = {
        listTaskBatches: async (options) =>
          options?.cursor
            ? { files: [{ path: good, revision: "good" }] }
            : { files: [{ path: bad, revision: "bad" }], nextCursor: bad },
        readTaskBatch: async (path) => ({
          path,
          revision: path === bad ? "bad" : "good",
          content: path === bad ? "{broken" : JSON.stringify(f.batch),
        }),
      };
      const run = () =>
        runTaskImportPass({
          db,
          store,
          ownerSubject: owner,
          checkpointKey: key,
          limit: 1,
        });
      expect(await run()).toMatchObject({ invalid: 1, hasMore: true });
      expect(
        (await db.ingestionCheckpoint.findUniqueOrThrow({ where: { key } }))
          .cursor,
      ).toBe(bad);
      expect(await run()).toMatchObject({ imported: 1, hasMore: false });
      expect(
        (await db.ingestionCheckpoint.findUniqueOrThrow({ where: { key } }))
          .cursor,
      ).toBeNull();
      expect(await run()).toMatchObject({ invalid: 1 });
      expect(
        await db.taskIngressAttempt.findFirst({
          where: { checkpointKey: key, sourcePath: bad },
        }),
      ).toMatchObject({ status: "INVALID", attemptCount: 1 });
    });
  },
);
