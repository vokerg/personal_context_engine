import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { createTaskRepository } from "@pce/db";
import {
  TaskCreateSchema,
  TaskSchema,
  TaskIdSchema,
  TaskListQuerySchema,
  TaskPageSchema,
  TaskReceiptSchema,
  TaskMutationSchema,
  TaskMutationResponseSchema,
  TaskHistoryQuerySchema,
  TaskHistorySchema,
} from "@pce/contracts";
import { requireSessionScope, type SessionAuth } from "./session-auth.js";

export type TaskService = ReturnType<typeof createTaskRepository>;
export function tasksEnabled(env: NodeJS.ProcessEnv): boolean {
  if (
    env.PCE_TASKS_ENABLED !== undefined &&
    !["true", "false"].includes(env.PCE_TASKS_ENABLED)
  )
    throw new Error("Invalid tasks feature flag");
  return env.PCE_TASKS_ENABLED === "true";
}
export function registerTaskRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  tasks: TaskService,
) {
  const requireScope =
    (scope: string) => (request: FastifyRequest, reply: FastifyReply) =>
      requireSessionScope(request, reply, auth, scope);
  const fail = (reply: FastifyReply, status: number, code: string) =>
    reply.code(status).send({ error: { code } });
  const badQuery = (request: FastifyRequest) =>
    Object.keys(request.query as object).length > 0;
  const sourcesAllowed = (request: FastifyRequest) =>
    request.authenticatedPrincipal!.scopes.includes("notes:read");
  const failure = (error: unknown, reply: FastifyReply) => {
    if (error instanceof Error && error.name === "TaskConflict")
      return fail(reply, 409, "CONFLICT");
    if (error instanceof Error && error.name === "TaskSourceUnavailable")
      return fail(reply, 404, "NOT_FOUND");
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        ["ZodError", "TaskCursorError"].includes(error.name))
    )
      return fail(reply, 400, "BAD_REQUEST");
    throw error;
  };
  app.get(
    "/api/v1/tasks",
    { preHandler: requireScope("tasks:read") },
    async (request, reply) => {
      const query = TaskListQuerySchema.safeParse(request.query);
      if (!query.success) return fail(reply, 400, "BAD_REQUEST");
      try {
        return TaskPageSchema.parse(
          await tasks.listByOwner(
            request.authenticatedPrincipal!.subject,
            query.data,
            sourcesAllowed(request),
          ),
        );
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  app.post(
    "/api/v1/tasks",
    { bodyLimit: 65536, preHandler: requireScope("tasks:write") },
    async (request, reply) => {
      const input = TaskCreateSchema.safeParse(request.body);
      if (!input.success || badQuery(request))
        return fail(reply, 400, "BAD_REQUEST");
      if (input.data.sources.length && !sourcesAllowed(request))
        return fail(reply, 403, "FORBIDDEN");
      try {
        return TaskReceiptSchema.parse(
          await tasks.createByOwner(
            request.authenticatedPrincipal!.subject,
            input.data,
            sourcesAllowed(request),
          ),
        );
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/tasks/:id",
    { preHandler: requireScope("tasks:read") },
    async (request, reply) => {
      if (
        !TaskIdSchema.safeParse(request.params.id).success ||
        badQuery(request)
      )
        return fail(reply, 400, "BAD_REQUEST");
      const task = await tasks.getByOwner(
        request.authenticatedPrincipal!.subject,
        request.params.id,
        sourcesAllowed(request),
      );
      return task ? TaskSchema.parse(task) : fail(reply, 404, "NOT_FOUND");
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/tasks/:id",
    { preHandler: requireScope("tasks:write") },
    async (request, reply) => {
      const input = TaskMutationSchema.safeParse(request.body);
      if (
        !input.success ||
        !TaskIdSchema.safeParse(request.params.id).success ||
        badQuery(request)
      )
        return fail(reply, 400, "BAD_REQUEST");
      try {
        const result = await tasks.changeByOwner(
          request.authenticatedPrincipal!.subject,
          request.params.id,
          input.data,
          sourcesAllowed(request),
        );
        return result
          ? TaskMutationResponseSchema.parse(result)
          : fail(reply, 404, "NOT_FOUND");
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/tasks/:id/events",
    { preHandler: requireScope("tasks:read") },
    async (request, reply) => {
      const query = TaskHistoryQuerySchema.safeParse(request.query);
      if (!query.success || !TaskIdSchema.safeParse(request.params.id).success)
        return fail(reply, 400, "BAD_REQUEST");
      const events = await tasks.historyByOwner(
        request.authenticatedPrincipal!.subject,
        request.params.id,
        query.data,
      );
      return events
        ? TaskHistorySchema.parse(events)
        : fail(reply, 404, "NOT_FOUND");
    },
  );
}
