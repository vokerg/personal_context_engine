import type { FastifyInstance } from "fastify";
import {
  NoteIdSchema,
  SaveSuggestedTasksSchema,
  SavedSuggestedTasksSchema,
  TaskSuggestionsSchema,
} from "@pce/contracts";
import { requireSessionScope, type SessionAuth } from "./session-auth.js";
import type { TaskService } from "./tasks.js";
import type { TaskSuggestionProvider } from "./task-suggestions-provider.js";

export interface TaskSuggestionService {
  provider: TaskSuggestionProvider;
  getSource(
    owner: string,
    noteId: string,
  ): Promise<{ captureId: string; originalInput: string } | null>;
}
export function registerTaskSuggestionRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  tasks: TaskService,
  service?: TaskSuggestionService,
) {
  const guard = async (
    req: Parameters<typeof requireSessionScope>[0],
    reply: Parameters<typeof requireSessionScope>[1],
  ) => {
    await requireSessionScope(req, reply, auth, "tasks:write");
    if (
      !reply.sent &&
      !req.authenticatedPrincipal!.scopes.includes("notes:read")
    )
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
  };
  app.get(
    "/api/v1/task-suggestions/config",
    { preHandler: guard },
    async () => ({ enabled: !!service, provider: "DeepSeek" }),
  );
  // Limits apply across owners in this single-user API process; restart resets them.
  let running = false;
  let nextAllowed = 0;
  let windowStart = 0;
  let requests = 0;
  if (!service) return;
  app.post<{ Params: { id: string } }>(
    "/api/v1/notes/:id/task-suggestions",
    { bodyLimit: 1024, preHandler: guard },
    async (req, reply) => {
      if (
        !NoteIdSchema.safeParse(req.params.id).success ||
        Object.keys(req.query as object).length ||
        (req.body !== undefined &&
          (typeof req.body !== "object" ||
            req.body === null ||
            Array.isArray(req.body) ||
            Object.keys(req.body).length))
      )
        return reply.code(400).send({ error: { code: "BAD_REQUEST" } });
      const source = await service.getSource(
        req.authenticatedPrincipal!.subject,
        req.params.id,
      );
      if (!source)
        return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (
        !source.originalInput.trim() ||
        Buffer.byteLength(source.originalInput, "utf8") > 24000
      )
        return reply.code(400).send({ error: { code: "BAD_REQUEST" } });
      const now = Date.now();
      if (now - windowStart >= 3600000) {
        windowStart = now;
        requests = 0;
      }
      if (running || now < nextAllowed || requests >= 20)
        return reply
          .header(
            "Retry-After",
            String(
              requests >= 20
                ? Math.ceil((windowStart + 3600000 - now) / 1000)
                : 5,
            ),
          )
          .code(429)
          .send({ error: { code: "RATE_LIMITED" } });
      running = true;
      nextAllowed = now + 5000;
      requests++;
      try {
        const result = await service.provider.suggest(source.originalInput);
        if (
          result.tasks.some((t) => !source.originalInput.includes(t.evidence))
        )
          throw new Error("Ungrounded suggestions");
        return TaskSuggestionsSchema.parse({
          ...result,
          noteId: req.params.id,
          captureId: source.captureId,
          model: service.provider.model,
        });
      } catch {
        return reply.code(503).send({ error: { code: "SERVICE_UNAVAILABLE" } });
      } finally {
        running = false;
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/notes/:id/tasks",
    { bodyLimit: 1048576, preHandler: guard },
    async (req, reply) => {
      const input = SaveSuggestedTasksSchema.safeParse(req.body);
      if (
        !input.success ||
        !NoteIdSchema.safeParse(req.params.id).success ||
        Object.keys(req.query as object).length
      )
        return reply.code(400).send({ error: { code: "BAD_REQUEST" } });
      try {
        const receipts = await tasks.createManyByOwner(
          req.authenticatedPrincipal!.subject,
          input.data.tasks.map(({ evidence, ...task }) => ({
            ...task,
            sources: [
              {
                noteId: req.params.id,
                captureId: input.data.captureId,
                evidence,
              },
            ],
          })),
          "api",
          true,
        );
        return SavedSuggestedTasksSchema.parse({ receipts });
      } catch (error) {
        // Repository errors may originate across a module/VM realm.
        const name =
          error && typeof error === "object" && "name" in error
            ? error.name
            : undefined;
        if (name === "TaskConflict")
          return reply.code(409).send({ error: { code: "CONFLICT" } });
        if (name === "TaskSourceUnavailable")
          return reply.code(404).send({ error: { code: "NOT_FOUND" } });
        if (name === "TypeError" || name === "ZodError")
          return reply.code(400).send({ error: { code: "BAD_REQUEST" } });
        throw error;
      }
    },
  );
}
