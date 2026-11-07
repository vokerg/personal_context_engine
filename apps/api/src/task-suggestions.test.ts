import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { taskSuggestionProvider } from "./task-suggestions-provider.js";
import { registerTaskSuggestionRoutes } from "./task-suggestions.js";
import type { SessionAuth } from "./session-auth.js";
import type { TaskService } from "./tasks.js";
const noteId = randomUUID(),
  captureId = randomUUID();
const actions = [
  "Repair the search form",
  "Add keyboard navigation",
  "Fix pagination",
  "Investigate slow imports",
  "Add import cursor",
];
const original = actions.join("; ");
const env = {
  PCE_TASK_SUGGESTIONS_ENABLED: "true",
  DEEPSEEK_API_KEY: "synthetic-key",
};
const envelope = (tasks: unknown, finish_reason = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason,
          message: { content: JSON.stringify({ tasks, reason: "" }) },
        },
      ],
    }),
  );
describe("on-demand DeepSeek adapter", () => {
  it("defaults off and validates configuration without calls", () => {
    const request = vi.fn();
    expect(taskSuggestionProvider({}, request)).toBeUndefined();
    expect(() =>
      taskSuggestionProvider({ PCE_TASK_SUGGESTIONS_ENABLED: "yes" }, request),
    ).toThrow();
    expect(() =>
      taskSuggestionProvider({ PCE_TASK_SUGGESTIONS_ENABLED: "true" }, request),
    ).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("produces five stable draft identities with exact evidence and bounded HTTPS JSON", async () => {
    const request = vi.fn(
      async (_url: unknown, init: RequestInit | undefined) => {
        const body = JSON.parse(String(init!.body));
        expect(body.messages[1].content).toBe(JSON.stringify({ original }));
        expect(body.max_tokens).toBe(6000);
        expect(body.response_format).toEqual({ type: "json_object" });
        expect(init!.redirect).toBe("error");
        return envelope(actions.map((title) => ({ title, evidence: title })));
      },
    );
    const result = await taskSuggestionProvider(env, request)!.suggest(
      original,
    );
    expect(result.tasks).toHaveLength(5);
    expect(new Set(result.tasks.map((t) => t.taskId)).size).toBe(5);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe(
      "https://api.deepseek.com/chat/completions",
    );
  });
  it("rejects ungrounded, truncated, oversized and invalid outputs without retrying", async () => {
    for (const response of [
      envelope([{ title: "Invented", evidence: "absent" }]),
      envelope([], "length"),
      new Response("x".repeat(96001)),
      new Response("private failure", { status: 429 }),
      envelope([{ title: "Bad", evidence: actions[0], dueAt: "tomorrow" }]),
    ]) {
      const request = vi.fn(async () => response);
      await expect(
        taskSuggestionProvider(env, request)!.suggest(original),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    }
    const request = vi.fn();
    await expect(
      taskSuggestionProvider(env, request)!.suggest("x".repeat(24001)),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("accepts a zero-task decision", async () => {
    expect(
      (
        await taskSuggestionProvider(env, async () => envelope([]))!.suggest(
          "Perhaps someday.",
        )
      ).tasks,
    ).toEqual([]);
  });
});
function setup(scopes = ["notes:read", "tasks:write"], enabled = true) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authenticatedPrincipal", null);
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  const auth = {
    verifyAccessToken: async () => ({ subject: "owner", scopes }),
    browserSession: async () => ({ ownerSubject: "owner" }),
    csrf: (req: { headers: Record<string, unknown> }) =>
      req.headers["x-pce-csrf"] === "synthetic",
  } as unknown as SessionAuth;
  const suggest = vi.fn(async () => ({
    tasks: [
      { taskId: randomUUID(), title: actions[0]!, evidence: actions[0]! },
    ],
    reason: "",
  }));
  const getSource = vi.fn(async (owner: string, id: string) =>
    owner === "owner" && id === noteId
      ? { captureId, originalInput: original }
      : null,
  );
  const createManyByOwner = vi.fn(async () => []);
  registerTaskSuggestionRoutes(
    app,
    auth,
    { createManyByOwner } as unknown as TaskService,
    enabled
      ? { provider: { model: "synthetic", suggest }, getSource }
      : undefined,
  );
  return { app, suggest, getSource, createManyByOwner };
}
const headers = { authorization: "Bearer " + "a".repeat(64) };
describe("suggestion authorization and persistence boundary", () => {
  it("gates provider calls, rejects scope/CSRF/input errors and foreign sources before egress", async () => {
    for (const scopes of [["notes:read"], ["tasks:write"]]) {
      const { app, suggest } = setup(scopes);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/notes/${noteId}/task-suggestions`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(suggest).not.toHaveBeenCalled();
      await app.close();
    }
    const { app, suggest, getSource } = setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/notes/${noteId}/task-suggestions`,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/notes/${randomUUID()}/task-suggestions`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/notes/${noteId}/task-suggestions?owner=other`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(suggest).not.toHaveBeenCalled();
    const result = await app.inject({
      method: "POST",
      url: `/api/v1/notes/${noteId}/task-suggestions`,
      headers,
      payload: {},
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(getSource).toHaveBeenLastCalledWith("owner", noteId);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/notes/${noteId}/task-suggestions`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(429);
    await app.close();
    const disabled = setup(undefined, false);
    expect(
      (
        await disabled.app.inject({
          url: "/api/v1/task-suggestions/config",
          headers,
        })
      ).json().enabled,
    ).toBe(false);
    expect(
      (
        await disabled.app.inject({
          method: "POST",
          url: `/api/v1/notes/${noteId}/task-suggestions`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    await disabled.app.close();
  });
  it("maps selected tasks into one shared atomic creation and sanitizes failures", async () => {
    const { app, createManyByOwner, suggest } = setup();
    const tasks = actions.map((title) => ({
      taskId: randomUUID(),
      title,
      evidence: title,
    }));
    createManyByOwner.mockRejectedValueOnce(
      Object.assign(new Error("private content"), { name: "TaskConflict" }),
    );
    const result = await app.inject({
      method: "POST",
      url: `/api/v1/notes/${noteId}/tasks`,
      headers,
      payload: { captureId, tasks },
    });
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain("private");
    expect(createManyByOwner).toHaveBeenCalledWith(
      "owner",
      tasks.map(({ evidence, ...task }) => ({
        ...task,
        sources: [{ noteId, captureId, evidence }],
      })),
      "api",
      true,
    );
    expect(suggest).not.toHaveBeenCalled();
    createManyByOwner.mockRejectedValueOnce(
      runInNewContext('new TypeError("synthetic invalid evidence")'),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/notes/${noteId}/tasks`,
          headers,
          payload: { captureId, tasks },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
});
