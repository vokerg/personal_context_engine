import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  TaskCreateSchema,
  TaskIdSchema,
  TaskListQuerySchema,
  TaskMutationSchema,
  TaskHistoryQuerySchema,
  TaskSchema,
  type TaskCreate,
  type TaskListQuery,
  type TaskMutation,
  type TaskHistoryQuery,
  type Task,
} from "@pce/contracts";

export class TaskConflict extends Error {
  constructor() {
    super("Task conflict");
    this.name = "TaskConflict";
  }
}
export class TaskSourceUnavailable extends Error {
  constructor() {
    super("Task source unavailable");
    this.name = "TaskSourceUnavailable";
  }
}
export class TaskCursorError extends Error {
  constructor() {
    super("Invalid task cursor");
    this.name = "TaskCursorError";
  }
}
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const ownerCheck = (owner: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(owner))
    throw new TypeError("Invalid task owner");
};
const include = {
  sources: {
    include: { note: { select: { removedAt: true } } },
    orderBy: { noteId: "asc" as const },
  },
} satisfies Prisma.TaskInclude;
type Row = Prisma.TaskGetPayload<{ include: typeof include }>;
function toTask(row: Row, canReadSources: boolean): Task {
  const visible = canReadSources
    ? row.sources.filter((s) => s.note.removedAt === null)
    : [];
  return TaskSchema.parse({
    taskId: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    revision: row.revision,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    origin: row.origin,
    sources: visible.map((s) => ({
      noteId: s.noteId,
      captureId: s.captureId,
      ...(s.evidence ? { evidence: s.evidence } : {}),
    })),
    unavailableSourceCount: row.sources.length - visible.length,
  });
}
export async function taskTransaction<T>(
  db: PrismaClient,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await db.$transaction(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code) &&
        attempt < 5
      )
        continue;
      throw error;
    }
  }
  throw new TaskConflict();
}

export async function createTaskRecords(
  tx: Prisma.TransactionClient,
  owner: string,
  inputs: TaskCreate[],
  origin: "api" | "github" = "api",
  canReadSources = true,
) {
  ownerCheck(owner);
  if (inputs.length > 20 || !["api", "github"].includes(origin))
    throw new TypeError("Invalid task batch");
  const tasks = inputs.map((v) => TaskCreateSchema.parse(v));
  if (new Set(tasks.map((t) => t.taskId)).size !== tasks.length)
    throw new TypeError("Duplicate task ID");
  const receipts = [];
  for (const input of tasks) {
    // Sort source relationships for a canonical request hash, never alter text.
    const sources = [...input.sources].sort((a, b) =>
      a.noteId.localeCompare(b.noteId),
    );
    const creationHash = digest({ ...input, sources });
    let row = await tx.task.findFirst({
      where: { id: input.taskId, ownerSubject: owner },
      include,
    });
    if (row) {
      if (row.creationHash !== creationHash) throw new TaskConflict();
      receipts.push({
        status: "DB_PERSISTED" as const,
        task: toTask(row, canReadSources),
        replayed: true,
      });
      continue;
    }
    // A global stable ID collision never adopts a task from another owner.
    if (await tx.task.count({ where: { id: input.taskId } }))
      throw new TaskConflict();
    for (const source of sources) {
      const note = await tx.note.findFirst({
        where: {
          id: source.noteId,
          ownerSubject: owner,
          captureId: source.captureId,
          removedAt: null,
        },
        select: { originalInput: true },
      });
      if (!note) throw new TaskSourceUnavailable();
      if (source.evidence && !note.originalInput.includes(source.evidence))
        throw new TypeError("Ungrounded task evidence");
    }
    await tx.task.create({
      data: {
        id: input.taskId,
        ownerSubject: owner,
        title: input.title,
        description: input.description ?? null,
        origin,
        creationHash,
      },
    });
    if (sources.length)
      await tx.taskSource.createMany({
        data: sources.map((s) => ({
          taskId: input.taskId,
          noteId: s.noteId,
          captureId: s.captureId,
          ownerSubject: owner,
          evidence: s.evidence ?? null,
        })),
      });
    await tx.taskEvent.create({
      data: {
        taskId: input.taskId,
        ownerSubject: owner,
        revision: 1,
        type: "CREATED",
        status: "OPEN",
      },
    });
    row = await tx.task.findFirstOrThrow({
      where: { id: input.taskId, ownerSubject: owner },
      include,
    });
    receipts.push({
      status: "DB_PERSISTED" as const,
      task: toTask(row, canReadSources),
      replayed: false,
    });
  }
  return receipts;
}

/** Shared bounded, all-or-nothing creation used by independent ingress adapters. */
export function createTaskRepository(db: PrismaClient) {
  const createManyByOwner = (
    owner: string,
    inputs: TaskCreate[],
    origin: "api" | "github" = "api",
    canReadSources = true,
  ) =>
    taskTransaction(db, (tx) =>
      createTaskRecords(tx, owner, inputs, origin, canReadSources),
    );
  return {
    createManyByOwner,
    async createByOwner(
      owner: string,
      input: TaskCreate,
      canReadSources = true,
    ) {
      return (
        await createManyByOwner(owner, [input], "api", canReadSources)
      )[0]!;
    },
    async getByOwner(owner: string, id: string, canReadSources = true) {
      ownerCheck(owner);
      TaskIdSchema.parse(id);
      const row = await db.task.findFirst({
        where: { id, ownerSubject: owner },
        include,
      });
      return row ? toTask(row, canReadSources) : null;
    },
    async listByOwner(
      owner: string,
      raw: TaskListQuery = {},
      canReadSources = true,
    ) {
      ownerCheck(owner);
      const query = TaskListQuerySchema.parse(raw);
      return db.$transaction(
        async (tx) => {
          const anchor = query.after
            ? await tx.task.findFirst({
                where: { id: query.after, ownerSubject: owner },
                select: { id: true, createdAt: true },
              })
            : null;
          if (query.after && !anchor) throw new TaskCursorError();
          const rows = await tx.task.findMany({
            where: {
              ownerSubject: owner,
              ...(query.status === "ALL" ? {} : { status: query.status }),
              ...(anchor
                ? {
                    OR: [
                      { createdAt: { lt: anchor.createdAt } },
                      { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                    ],
                  }
                : {}),
            },
            include,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: query.limit + 1,
          });
          return {
            tasks: rows
              .slice(0, query.limit)
              .map((row) => toTask(row, canReadSources)),
            nextCursor:
              rows.length > query.limit ? rows[query.limit - 1]!.id : null,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
    async changeByOwner(
      owner: string,
      id: string,
      raw: TaskMutation,
      canReadSources = true,
    ) {
      ownerCheck(owner);
      TaskIdSchema.parse(id);
      const input = TaskMutationSchema.parse(raw);
      const payloadHash = digest({ taskId: id, ...input });
      return taskTransaction(db, async (tx) => {
        const task = await tx.task.findFirst({
          where: { id, ownerSubject: owner },
          include,
        });
        if (!task) return null;
        const command = await tx.taskCommand.findUnique({
          where: {
            ownerSubject_id: { ownerSubject: owner, id: input.commandId },
          },
        });
        if (command) {
          if (command.payloadHash !== payloadHash || command.taskId !== id)
            throw new TaskConflict();
          return {
            task: toTask(task, canReadSources),
            changed: false,
            replayed: true,
          };
        }
        if (task.revision !== input.expectedRevision) throw new TaskConflict();
        const changed = task.status !== input.status;
        if (changed) {
          const result = await tx.task.updateMany({
            where: {
              id,
              ownerSubject: owner,
              revision: input.expectedRevision,
            },
            data: {
              status: input.status,
              revision: { increment: 1 },
              completedAt: input.status === "COMPLETED" ? new Date() : null,
            },
          });
          if (result.count !== 1) throw new TaskConflict();
          await tx.taskEvent.create({
            data: {
              taskId: id,
              ownerSubject: owner,
              revision: task.revision + 1,
              status: input.status,
              type: input.status === "COMPLETED" ? "COMPLETED" : "REOPENED",
            },
          });
        }
        await tx.taskCommand.create({
          data: {
            ownerSubject: owner,
            id: input.commandId,
            taskId: id,
            payloadHash,
          },
        });
        const current = await tx.task.findFirstOrThrow({
          where: { id, ownerSubject: owner },
          include,
        });
        return {
          task: toTask(current, canReadSources),
          changed,
          replayed: false,
        };
      });
    },
    async historyByOwner(
      owner: string,
      id: string,
      raw: TaskHistoryQuery = {},
    ) {
      ownerCheck(owner);
      TaskIdSchema.parse(id);
      const query = TaskHistoryQuerySchema.parse(raw);
      if (!(await db.task.count({ where: { id, ownerSubject: owner } })))
        return null;
      const events = await db.taskEvent.findMany({
        where: {
          taskId: id,
          ownerSubject: owner,
          revision: { gt: query.afterRevision },
        },
        orderBy: { revision: "asc" },
        take: query.limit + 1,
      });
      return {
        events: events.slice(0, query.limit).map((e) => ({
          revision: e.revision,
          type: e.type,
          status: e.status,
          at: e.at.toISOString(),
        })),
        nextRevision:
          events.length > query.limit
            ? events[query.limit - 1]!.revision
            : null,
      };
    },
  };
}
