import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  createNoteRepository,
  createTaskRepository,
} from "./index.js";

const url = process.env.PCE_DB_TEST_URL;
describe.skipIf(!url)("first-class Tasks on PostgreSQL", () => {
  let db: PrismaClient;
  const owner = "tasks-" + randomUUID(),
    foreign = "foreign-" + randomUUID();
  let contextTaskId: string;
  const noteId = randomUUID(),
    captureId = randomUUID();
  const original = "Buy synthetic filters and email the synthetic landlord.";
  const source = { noteId, captureId, evidence: "Buy synthetic filters" };
  const markdown = `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: 2026-10-25T09:00:00+01:00
source: import
kind: task
domains: []
projects: []
tags: [task]
action_hint: none
review_required: false
title: Synthetic task source
---

# Synthetic task source

## Summary

Synthetic task source.

## Original input

${original}
`;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
    await createNoteRepository(db).importMarkdown({
      ownerSubject: owner,
      sourcePath: `inbox/2026-10-25_${noteId}.md`,
      sourceRevision: "synthetic-task-v1",
      markdown,
    });
  });
  afterAll(async () => {
    if (!db) return;
    for (const table of [db.taskCommand, db.taskEvent, db.taskSource, db.task])
      await table.deleteMany({
        where: { ownerSubject: { in: [owner, foreign] } },
      });
    await db.note.deleteMany({ where: { id: noteId } });
    await db.capture.deleteMany({ where: { id: captureId } });
    await db.$disconnect();
  });
  it("never derives Tasks from kind/tags and atomically links multiple Tasks to one unchanged original", async () => {
    const repo = createTaskRepository(db);
    expect(await db.task.count({ where: { ownerSubject: owner } })).toBe(0);
    expect(
      (await repo.listByOwner(owner, { q: "Synthetic task source" })).tasks,
    ).toEqual([]);
    const before = await db.note.findUniqueOrThrow({ where: { id: noteId } });
    const inputs = ["Buy filters", "Email landlord", "Check spare filter"].map(
      (title) => ({ taskId: randomUUID(), title, sources: [source] }),
    );
    const receipts = await repo.createManyByOwner(owner, inputs);
    expect(receipts.map((r) => r.task.sources)).toMatchObject([
      [source],
      [source],
      [source],
    ]);
    expect(await db.note.findUnique({ where: { id: noteId } })).toEqual(before);
    expect(
      (
        await repo.createByOwner(owner, {
          taskId: randomUUID(),
          title: "Independent task",
        })
      ).task.sources,
    ).toEqual([]);
  });
  it("deduplicates concurrent creates and rejects changed payload/owner without adopting anything", async () => {
    const repo = createTaskRepository(db),
      input = {
        taskId: randomUUID(),
        title: "Retry safely",
        sources: [source],
      };
    const replies = await Promise.all([
      repo.createByOwner(owner, input),
      repo.createByOwner(owner, input),
    ]);
    expect(replies.map((r) => r.replayed).sort()).toEqual([false, true]);
    await expect(
      repo.createByOwner(owner, { ...input, title: "Different" }),
    ).rejects.toMatchObject({ name: "TaskConflict" });
    await expect(repo.createByOwner(foreign, input)).rejects.toMatchObject({
      name: "TaskConflict",
    });
    expect(await repo.getByOwner(foreign, input.taskId)).toBeNull();
    expect(
      await repo.changeByOwner(foreign, input.taskId, {
        commandId: randomUUID(),
        expectedRevision: 1,
        status: "COMPLETED",
      }),
    ).toBeNull();
    expect(await repo.historyByOwner(foreign, input.taskId)).toBeNull();
  });
  it("rolls back all creations on invalid, foreign or ungrounded source evidence", async () => {
    const repo = createTaskRepository(db),
      first = { taskId: randomUUID(), title: "Must roll back" };
    await expect(
      repo.createManyByOwner(owner, [
        first,
        {
          taskId: randomUUID(),
          title: "Invalid source",
          sources: [{ ...source, captureId: randomUUID() }],
        },
      ]),
    ).rejects.toMatchObject({ name: "TaskSourceUnavailable" });
    expect(await repo.getByOwner(owner, first.taskId)).toBeNull();
    await expect(
      repo.createByOwner(foreign, { ...first, sources: [source] }),
    ).rejects.toMatchObject({ name: "TaskSourceUnavailable" });
    await expect(
      repo.createByOwner(owner, {
        ...first,
        sources: [{ ...source, evidence: "Invented commitment" }],
      }),
    ).rejects.toThrow("Ungrounded");
    await expect(
      db.taskSource.create({
        data: { taskId: randomUUID(), ownerSubject: foreign, ...source },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
  it("completes/reopens with durable idempotency and CAS, preserving source and historical events", async () => {
    const repo = createTaskRepository(db),
      input = {
        taskId: randomUUID(),
        title: "Complete one only",
        sources: [source],
      };
    await repo.createByOwner(owner, input);
    const before = await db.note.findUnique({ where: { id: noteId } });
    const complete = {
      commandId: randomUUID(),
      expectedRevision: 1,
      status: "COMPLETED" as const,
    };
    const replies = await Promise.all([
      repo.changeByOwner(owner, input.taskId, complete),
      repo.changeByOwner(owner, input.taskId, complete),
    ]);
    expect(replies.map((r) => r!.replayed).sort()).toEqual([false, true]);
    expect(replies[0]!.task).toMatchObject({
      status: "COMPLETED",
      revision: 2,
      completedAt: expect.any(String),
    });
    await expect(
      repo.changeByOwner(owner, input.taskId, {
        ...complete,
        commandId: randomUUID(),
        status: "OPEN",
      }),
    ).rejects.toMatchObject({ name: "TaskConflict" });
    const same = await repo.changeByOwner(owner, input.taskId, {
      commandId: randomUUID(),
      expectedRevision: 2,
      status: "COMPLETED",
    });
    expect(same).toMatchObject({ changed: false, task: { revision: 2 } });
    expect(
      (await repo.listByOwner(owner)).tasks.map((t) => t.taskId),
    ).not.toContain(input.taskId);
    expect(
      (await repo.listByOwner(owner, { status: "COMPLETED" })).tasks.map(
        (t) => t.taskId,
      ),
    ).toContain(input.taskId);
    expect(
      (await repo.changeByOwner(owner, input.taskId, {
        commandId: randomUUID(),
        expectedRevision: 2,
        status: "OPEN",
      }))!.task,
    ).toMatchObject({ status: "OPEN", revision: 3, completedAt: null });
    // A delayed completion retry or importer replay cannot complete/reopen again.
    expect(
      (await repo.changeByOwner(owner, input.taskId, complete))!.task.status,
    ).toBe("OPEN");
    expect((await repo.createByOwner(owner, input)).task.revision).toBe(3);
    const first = await repo.historyByOwner(owner, input.taskId, { limit: 2 });
    expect(first!.events.map((e) => e.type)).toEqual(["CREATED", "COMPLETED"]);
    expect(
      (await repo.historyByOwner(owner, input.taskId, {
        afterRevision: first!.nextRevision!,
      }))!.events.map((e) => e.type),
    ).toEqual(["REOPENED"]);
    expect(await db.note.findUnique({ where: { id: noteId } })).toEqual(before);
  });
  it("serializes distinct concurrent commands: one wins, one conflicts", async () => {
    const repo = createTaskRepository(db),
      taskId = randomUUID();
    await repo.createByOwner(owner, { taskId, title: "CAS task" });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        repo.changeByOwner(owner, taskId, {
          commandId: randomUUID(),
          expectedRevision: 1,
          status: "COMPLETED",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { name: "TaskConflict" },
    });
    expect((await repo.historyByOwner(owner, taskId))!.events).toHaveLength(2);
  });
  it("paginates without overlap and rejects foreign/unknown anchors", async () => {
    const repo = createTaskRepository(db),
      ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await repo.listByOwner(owner, {
        status: "ALL",
        limit: 2,
        ...(after ? { after } : {}),
      });
      ids.push(...page.tasks.map((t) => t.taskId));
      after = page.nextCursor ?? undefined;
    } while (after);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(
      await db.task.count({ where: { ownerSubject: owner } }),
    );
    await expect(
      repo.listByOwner(foreign, { after: ids[0]! }),
    ).rejects.toMatchObject({ name: "TaskCursorError" });
  });
  it("searches independent Tasks with multilingual stemming, literal identifiers and immediate completion filters", async () => {
    const repo = createTaskRepository(db);
    const ru = randomUUID(),
      en = randomUUID(),
      wrong = randomUUID();
    await repo.createManyByOwner(owner, [
      {
        taskId: ru,
        title: "Купить фильтры",
        description: "Synthetic part ZX9401",
      },
      {
        taskId: en,
        title: "Buy filters",
        description: "Synthetic part ZX9401",
      },
      {
        taskId: wrong,
        title: "Unrelated task",
        description: "Synthetic part ZX94010",
      },
    ]);
    expect(
      (await repo.listByOwner(owner, { q: "фильтр" })).tasks.map(
        (t) => t.taskId,
      ),
    ).toContain(ru);
    expect(
      (await repo.listByOwner(owner, { q: "filter" })).tasks.map(
        (t) => t.taskId,
      ),
    ).toContain(en);
    const ids = (
      await repo.listByOwner(owner, { q: "ZX9401", status: "ALL" })
    ).tasks.map((t) => t.taskId);
    expect(new Set(ids)).toEqual(new Set([ru, en]));
    expect(
      (await repo.listByOwner(foreign, { q: "ZX9401", status: "ALL" })).tasks,
    ).toEqual([]);
    await repo.changeByOwner(owner, ru, {
      commandId: randomUUID(),
      expectedRevision: 1,
      status: "COMPLETED",
    });
    expect(
      (await repo.listByOwner(owner, { q: "фильтр" })).tasks.map(
        (t) => t.taskId,
      ),
    ).not.toContain(ru);
    expect(
      (
        await repo.listByOwner(owner, { q: "фильтр", status: "COMPLETED" })
      ).tasks.map((t) => t.taskId),
    ).toContain(ru);
    expect(
      (await repo.historyByOwner(owner, ru))!.events.map((e) => e.type),
    ).toEqual(["CREATED", "COMPLETED"]);
  });
  it("searches visible source context only with Note permission and returns distinct capture/Task timestamps", async () => {
    const repo = createTaskRepository(db);
    contextTaskId = randomUUID();
    await repo.createByOwner(owner, {
      taskId: contextTaskId,
      title: "Check linked thing",
      sources: [{ ...source, evidence: "synthetic landlord" }],
    });
    const withContext = await repo.listByOwner(owner, { q: "landlord" }, true);
    const task = withContext.tasks.find((t) => t.taskId === contextTaskId)!;
    expect(task.sources[0]!.capturedAt).toBe("2026-10-25T08:00:00.000Z");
    expect(task.createdAt).not.toBe(task.sources[0]!.capturedAt);
    expect(
      (await repo.listByOwner(owner, { q: "landlord" }, false)).tasks.map(
        (t) => t.taskId,
      ),
    ).not.toContain(contextTaskId);
  });
  it("paginates a dedicated Task query without mixing Note matches or skipping same-time Tasks", async () => {
    const repo = createTaskRepository(db),
      ids = [randomUUID(), randomUUID(), randomUUID()];
    await repo.createManyByOwner(
      owner,
      ids.map((taskId) => ({ taskId, title: "Paginatedaction" })),
    );
    const found: string[] = [];
    let after: string | undefined;
    do {
      const page = await repo.listByOwner(owner, {
        q: "paginatedaction",
        limit: 1,
        ...(after ? { after } : {}),
      });
      found.push(...page.tasks.map((t) => t.taskId));
      after = page.nextCursor ?? undefined;
    } while (after);
    expect(new Set(found)).toEqual(new Set(ids));
    expect(found).toHaveLength(3);
  });
  it("keeps completed Tasks readable while source archive/removal and scope suppress source evidence independently", async () => {
    const repo = createTaskRepository(db),
      taskId = randomUUID();
    await repo.createByOwner(owner, {
      taskId,
      title: "Retained task",
      sources: [source],
    });
    await repo.changeByOwner(owner, taskId, {
      commandId: randomUUID(),
      expectedRevision: 1,
      status: "COMPLETED",
    });
    await db.note.update({
      where: { id: noteId },
      data: { archivedAt: new Date() },
    });
    expect((await repo.getByOwner(owner, taskId))!.sources).toMatchObject([
      source,
    ]);
    expect(await repo.getByOwner(owner, taskId, false)).toMatchObject({
      sources: [],
      unavailableSourceCount: 1,
    });
    await db.note.update({
      where: { id: noteId },
      data: { removedAt: new Date(), removedBy: owner },
    });
    expect(await repo.getByOwner(owner, taskId)).toMatchObject({
      status: "COMPLETED",
      sources: [],
      unavailableSourceCount: 1,
    });
    expect(
      (
        await repo.listByOwner(owner, { q: "landlord", status: "ALL" })
      ).tasks.map((t) => t.taskId),
    ).not.toContain(contextTaskId);
    await expect(
      repo.createByOwner(owner, {
        taskId: randomUUID(),
        title: "Hidden source",
        sources: [source],
      }),
    ).rejects.toMatchObject({ name: "TaskSourceUnavailable" });
  });
});
