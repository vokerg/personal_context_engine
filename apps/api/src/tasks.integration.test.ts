import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, createTaskRepository } from "@pce/db";
import { createApp } from "./app.js";
import { createSessionAuth } from "./session-auth.js";
import { tasksEnabled } from "./tasks.js";

describe("task gate", () => {
  it("defaults off and rejects misspellings", () => {
    expect(tasksEnabled({})).toBe(false);
    expect(tasksEnabled({ PCE_TASKS_ENABLED: "true" })).toBe(true);
    expect(() => tasksEnabled({ PCE_TASKS_ENABLED: "yes" })).toThrow();
  });
});
describe.skipIf(!process.env.PCE_DB_TEST_URL)(
  "scoped Task HTTP and OAuth",
  () => {
    const owner = "task-http-" + randomUUID(),
      origin = "http://127.0.0.1:4310",
      issuer = "http://127.0.0.1:3110";
    let db: PrismaClient, app: ReturnType<typeof createApp>;
    let headers: Record<string, string>, cookie: string;
    const taskId = randomUUID();
    const grant = async (scope: string) => {
      const result = await app.inject({
        method: "POST",
        url: "/auth/token",
        headers,
        payload: { scope },
      });
      expect(result.statusCode).toBe(200);
      return { authorization: "Bearer " + result.json().access_token };
    };
    beforeAll(async () => {
      db = new PrismaClient({
        datasources: { db: { url: process.env.PCE_DB_TEST_URL! } },
      });
      await db.$connect();
      const auth = createSessionAuth(db, {
        mode: "dev-single-user",
        ownerSubject: owner,
        origin,
        issuer,
        audience: issuer + "/mcp",
        secure: false,
      });
      app = createApp({
        config: {
          environment: "test",
          host: "127.0.0.1",
          port: 3110,
          requiresDatabase: false,
          corsOrigin: origin,
          auth: null,
        },
        dependencies: {
          sessionAuth: auth,
          tasks: createTaskRepository(db),
          oauth: {
            db,
            clients: [
              {
                clientId: "old-notes-client",
                redirectUris: ["http://127.0.0.1:3001/callback"],
                scopes: ["notes:read"],
              },
              {
                clientId: "task-client",
                redirectUris: ["http://127.0.0.1:3001/callback"],
                scopes: ["tasks:read", "tasks:write"],
              },
            ],
          },
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/auth/dev-session",
        headers: { origin },
        payload: {},
      });
      cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      headers = {
        cookie,
        origin,
        "x-pce-csrf": login.cookies.find((c) => c.name === "pce_csrf")!.value,
      };
    });
    afterAll(async () => {
      if (app) await app.close();
      if (!db) return;
      await db.taskCommand.deleteMany({ where: { ownerSubject: owner } });
      await db.taskEvent.deleteMany({ where: { ownerSubject: owner } });
      await db.task.deleteMany({ where: { ownerSubject: owner } });
      await db.authSession.deleteMany({ where: { ownerSubject: owner } });
      await db.$disconnect();
    });
    it("enforces authentication, independent scopes, CSRF, and strict payloads", async () => {
      expect((await app.inject("/api/v1/tasks")).statusCode).toBe(401);
      const old = await grant("notes:read capture:write");
      expect(
        (await app.inject({ url: "/api/v1/tasks", headers: old })).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/tasks",
            headers: { cookie, origin },
            payload: { taskId, title: "Test" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/tasks",
            headers,
            payload: { taskId, title: "Test", ownerSubject: "forged" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/tasks?owner=forged",
            headers,
            payload: { taskId, title: "Test" },
          })
        ).statusCode,
      ).toBe(400);
      const write = await grant("tasks:write");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/tasks",
            headers: write,
            payload: {
              taskId,
              title: "Test",
              sources: [{ noteId: randomUUID(), captureId: randomUUID() }],
            },
          })
        ).statusCode,
      ).toBe(403);
      const saved = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        headers: write,
        payload: { taskId, title: "Synthetic HTTP task" },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        status: "DB_PERSISTED",
        replayed: false,
      });
      expect(
        (await app.inject({ url: "/api/v1/tasks", headers: write })).statusCode,
      ).toBe(403);
    });
    it("confirms completion/reopen, history, conflicts, unknown parity and bounded lists", async () => {
      const token = await grant("tasks:read tasks:write");
      const complete = {
        commandId: randomUUID(),
        expectedRevision: 1,
        status: "COMPLETED",
      };
      const result = await app.inject({
        method: "PATCH",
        url: `/api/v1/tasks/${taskId}`,
        headers: token,
        payload: complete,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().task).toMatchObject({
        status: "COMPLETED",
        revision: 2,
      });
      expect(
        (await app.inject({ url: "/api/v1/tasks", headers: token })).json()
          .tasks,
      ).toEqual([]);
      expect(
        (
          await app.inject({ url: "/api/v1/tasks?status=ALL", headers: token })
        ).json().tasks,
      ).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/v1/tasks/${taskId}`,
            headers: token,
            payload: { ...complete, commandId: randomUUID(), status: "OPEN" },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/v1/tasks/${taskId}`,
            headers: token,
            payload: {
              commandId: randomUUID(),
              expectedRevision: 2,
              status: "OPEN",
            },
          })
        ).json().task.status,
      ).toBe("OPEN");
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/v1/tasks/${taskId}`,
            headers: token,
            payload: complete,
          })
        ).json(),
      ).toMatchObject({
        replayed: true,
        task: { status: "OPEN", revision: 3 },
      });
      expect(
        (
          await app.inject({
            url: `/api/v1/tasks/${taskId}/events`,
            headers: token,
          })
        )
          .json()
          .events.map((e: { type: string }) => e.type),
      ).toEqual(["CREATED", "COMPLETED", "REOPENED"]);
      expect(
        (
          await app.inject({
            url: `/api/v1/tasks/${randomUUID()}`,
            headers: token,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/v1/tasks/${randomUUID()}`,
            headers: token,
            payload: complete,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ url: "/api/v1/tasks?limit=101", headers: token }))
          .statusCode,
      ).toBe(400);
    });
    it("requires new explicit task OAuth consent; existing notes clients cannot request task access", async () => {
      const params = {
        response_type: "code",
        client_id: "old-notes-client",
        redirect_uri: "http://127.0.0.1:3001/callback",
        resource: issuer + "/mcp",
        scope: "tasks:read tasks:write",
        state: "s".repeat(32),
        code_challenge: createHash("sha256")
          .update("v".repeat(64))
          .digest("base64url"),
        code_challenge_method: "S256",
      };
      expect(
        (
          await app.inject({
            url: "/oauth/authorize?" + new URLSearchParams(params),
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(400);
      const consent = await app.inject({
        url:
          "/oauth/authorize?" +
          new URLSearchParams({ ...params, client_id: "task-client" }),
        headers: { cookie },
      });
      expect(consent.statusCode).toBe(200);
      expect(consent.body).toContain(
        "tasks:write permits creating, completing and reopening Tasks",
      );
      // Existing notes-only access is still notes-only even after registration changes.
      expect(
        (
          await app.inject({
            url: "/api/v1/tasks",
            headers: await grant("notes:read"),
          })
        ).statusCode,
      ).toBe(403);
    });
  },
);
