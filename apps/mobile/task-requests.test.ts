import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, type Task } from "@pce/api-client";
import { TaskRequests, taskFailure } from "./task-requests";
import { nativeScopes } from "./task-feature";
import { verifiedConfig } from "./session";
const id = "00000000-0000-4000-8000-000000000001";
const fixture = (): Task => ({
  taskId: id,
  title: "Synthetic Task",
  description: null,
  status: "OPEN",
  revision: 1,
  origin: "api",
  createdAt: "2026-10-25T10:00:00Z",
  updatedAt: "2026-10-25T10:00:00Z",
  completedAt: null,
  sources: [],
  unavailableSourceCount: 0,
});
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status });
describe("native stable Task requests", () => {
  it("blocks duplicate taps, waits for acknowledgement and preserves exact command identity after uncertainty", async () => {
    const task = fixture();
    let ack: (() => void) | null = null;
    const bodies: unknown[] = [];
    let failure = true;
    const request = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (failure) throw new TypeError("Private transport detail");
        await new Promise<void>((resolve) => {
          ack = resolve;
        });
        return json({
          task: {
            ...task,
            status: "COMPLETED",
            completedAt: "2026-10-25T11:00:00Z",
            revision: 2,
          },
          changed: true,
          replayed: false,
        });
      },
    );
    const store = new TaskRequests(
      {
        baseUrl: "https://api.example",
        getAccessToken: () => "synthetic",
        request,
      },
      () => id,
    );
    await expect(store.change(task)).rejects.toThrow();
    expect(store.pendingTaskId).toBe(id);
    expect(task.status).toBe("OPEN");
    // A fresh checkbox press cannot silently replace/retry an uncertain command.
    expect(await store.change(task)).toBeNull();
    failure = false;
    const retry = store.change();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.change()).toBeNull();
    expect(store.changing).toBe(true);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(task.status).toBe("OPEN");
    ack!();
    expect((await retry)!.task.status).toBe("COMPLETED");
    expect(store.pendingTaskId).toBeNull();
    expect(store.changing).toBe(false);
  });
  it("clears stale CAS commands but keeps transport/permission failures safe and recoverable", async () => {
    let number = 1;
    const commands: string[] = [];
    const request = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        commands.push(JSON.parse(String(init?.body)).commandId);
        return json({ error: { code: "CONFLICT" } }, 409);
      },
    );
    const store = new TaskRequests(
      {
        baseUrl: "https://api.example",
        getAccessToken: () => "synthetic",
        request,
      },
      () => `00000000-0000-4000-8000-${String(number++).padStart(12, "0")}`,
    );
    await expect(store.change(fixture())).rejects.toMatchObject({
      status: 409,
    });
    expect(store.pendingTaskId).toBeNull();
    await expect(store.change(fixture())).rejects.toMatchObject({
      status: 409,
    });
    expect(commands[0]).not.toBe(commands[1]);
    expect(taskFailure(new Error("private source payload"))).not.toContain(
      "private source payload",
    );
    for (const status of [401, 403, 404, 409])
      expect(taskFailure(new ApiRequestError(status, "FORBIDDEN"))).toMatch(
        /Session|Reconnect|unavailable|changed/,
      );
  });
  it("retains one creation payload after uncertainty, without generating a replacement ID or inferred date", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const generator = vi.fn(() => id);
    const request = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) throw new TypeError("Synthetic response lost");
        return json({
          status: "DB_PERSISTED",
          task: fixture(),
          replayed: true,
        });
      },
    );
    const store = new TaskRequests(
      {
        baseUrl: "https://api.example",
        getAccessToken: () => "synthetic",
        request,
      },
      generator,
    );
    await expect(store.create({ title: "Synthetic Task" })).rejects.toThrow();
    expect(store.pendingCreation).toBe(true);
    expect(
      (await store.create({ title: "Do not replace the pending request" }))!
        .replayed,
    ).toBe(true);
    expect(generator).toHaveBeenCalledOnce();
    expect(bodies[0]).toEqual(bodies[1]);
    expect(Object.keys(bodies[0]!).sort()).toEqual([
      "sources",
      "taskId",
      "title",
    ]);
    expect(store.pendingCreation).toBe(false);
  });
  it("adds Task scopes only under the explicit feature choice without changing existing grants", () => {
    expect(nativeScopes(false)).toEqual([
      "notes:read",
      "capture:write",
      "tags:write",
    ]);
    expect(nativeScopes(true)).toEqual([
      ...nativeScopes(false),
      "tasks:read",
      "tasks:write",
    ]);
    expect(
      verifiedConfig({
        apiOrigin: "https://api.example",
        clientId: "synthetic-ios",
        callback: "pce://oauth/callback",
        scopes: nativeScopes(true),
      }).scopes,
    ).toContain("tasks:write");
    expect(() =>
      verifiedConfig({
        apiOrigin: "https://api.example",
        clientId: "synthetic-ios",
        callback: "pce://oauth/callback",
        scopes: ["tasks:read"],
      }),
    ).toThrow();
  });
});
