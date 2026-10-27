import { describe, expect, it, vi } from "vitest";
import { changeTask, createTask, getTasks } from "./index.js";
const taskId = "00000000-0000-4000-8000-000000000001";
describe("typed Task transport", () => {
  it("validates requests before token access and propagates safe conflicts", async () => {
    const getAccessToken = vi.fn(() => "fake");
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "CONFLICT" } }), {
          status: 409,
        }),
    );
    const options = { baseUrl: "https://api.example", getAccessToken, request };
    expect(() => createTask(options, { taskId, title: " " })).toThrow();
    expect(() => getTasks(options, { q: "a".repeat(501) })).toThrow();
    expect(getAccessToken).not.toHaveBeenCalled();
    await expect(
      changeTask(options, taskId, {
        commandId: taskId,
        expectedRevision: 1,
        status: "COMPLETED",
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });
  it("sends server-side status pagination through shared authenticated transport", async () => {
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toBe(
          "https://api.example/api/v1/tasks?status=COMPLETED&limit=2&after=" +
            taskId,
        );
        expect(init?.headers).toMatchObject({ Authorization: "Bearer fake" });
        return new Response(JSON.stringify({ tasks: [], nextCursor: null }));
      },
    );
    await expect(
      getTasks(
        {
          baseUrl: "https://api.example",
          getAccessToken: () => "fake",
          request,
        },
        { status: "COMPLETED", limit: 2, after: taskId },
      ),
    ).resolves.toEqual({ tasks: [], nextCursor: null });
  });
});

it("encodes task-only queries without exposing them in transport errors", async () => {
  const request = vi.fn(async (url: RequestInfo | URL) => {
    expect(new URL(String(url)).searchParams.get("q")).toBe("купить фильтр");
    return new Response(JSON.stringify({ tasks: [], nextCursor: null }));
  });
  await getTasks(
    { baseUrl: "https://api.example", getAccessToken: () => "fake", request },
    { q: "купить фильтр", status: "ALL" },
  );
});
