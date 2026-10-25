// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "@pce/api-client";
import { TasksPanel } from "./TasksPanel.js";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];
const noteId = "00000000-0000-4000-8000-000000000004";
let root: Root, container: HTMLDivElement, tasks: Task[];
let commands: Array<{
  taskId: string;
  commandId: string;
  expectedRevision: number;
  status: string;
}>;
let ack: (() => void) | null,
  delay: boolean,
  failMutation: boolean,
  conflict: boolean;
let requests: string[];
const onOpenNote = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.cookie = "pce_csrf=synthetic-csrf";
  tasks = ids.map((taskId, i) => ({
    taskId,
    title: ["Buy filters", "Email landlord", "Check invoice"][i]!,
    description: i === 0 ? "<script>untrusted Task</script>" : null,
    status: "OPEN",
    revision: 1,
    completedAt: null,
    createdAt: "2026-10-25T10:00:00Z",
    updatedAt: "2026-10-25T10:00:00Z",
    origin: "api",
    sources: [
      {
        noteId,
        captureId: "00000000-0000-4000-8000-000000000005",
        evidence: "Synthetic original remains unchanged",
        capturedAt: "2026-10-24T10:00:00Z",
      },
    ],
    unavailableSourceCount: 0,
  }));
  commands = [];
  requests = [];
  ack = null;
  delay = false;
  failMutation = false;
  conflict = false;
  onOpenNote.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(raw));
      requests.push(url.pathname + url.search);
      const id = url.pathname.split("/").at(-1)!;
      if (init?.method === "PATCH") {
        expect(init.credentials).toBe("include");
        expect(init.headers).toMatchObject({ "X-PCE-CSRF": "synthetic-csrf" });
        const body = JSON.parse(String(init.body));
        commands.push({ taskId: id, ...body });
        if (failMutation)
          throw new TypeError("Private network error must not be displayed");
        if (conflict) return json({ error: { code: "CONFLICT" } }, 409);
        const task = tasks.find((t) => t.taskId === id)!;
        if (delay)
          await new Promise<void>((resolve) => {
            ack = resolve;
          });
        task.status = body.status;
        task.revision++;
        task.completedAt =
          body.status === "COMPLETED" ? "2026-10-25T11:00:00Z" : null;
        return json({ task, changed: true, replayed: false });
      }
      if (url.pathname.endsWith("/events"))
        return json({
          events: [
            {
              revision: 1,
              type: "CREATED",
              status: "OPEN",
              at: "2026-10-25T10:00:00Z",
            },
          ],
          nextRevision: null,
        });
      if (url.pathname === "/api/v1/tasks") {
        const status = url.searchParams.get("status"),
          q = url.searchParams.get("q")?.toLowerCase();
        const visible = tasks.filter(
          (t) =>
            (!status || status === "ALL" || t.status === status) &&
            (!q || t.title.toLowerCase().includes(q)),
        );
        return json({ tasks: visible, nextCursor: null });
      }
      const task = tasks.find((t) => t.taskId === id);
      return task ? json(task) : json({ error: { code: "NOT_FOUND" } }, 404);
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <TasksPanel
        baseUrl="https://api.example"
        token="synthetic"
        useSessionCookie
        onOpenNote={onOpenNote}
      />,
    );
  });
  await flush();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  )!;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await flush();
};

it("completes only one of three after acknowledgement, retains context, and reopens from Completed", async () => {
  delay = true;
  const checkbox = container.querySelector<HTMLInputElement>(
    '[aria-label="Complete Buy filters"]',
  )!;
  await act(async () => {
    checkbox.click();
    checkbox.click();
  });
  expect(commands).toHaveLength(1);
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  expect(checkbox.checked).toBe(false);
  await act(async () => {
    ack!();
  });
  await flush();
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  expect(container.textContent).toContain("available in Completed");
  await click(button("Completed"));
  expect(
    container.querySelector('[aria-label="Reopen Buy filters"]'),
  ).not.toBeNull();
  await click(
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Buy filters"),
    )!,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("<script>untrusted Task</script>");
  expect(container.textContent).toContain(
    "Synthetic original remains unchanged",
  );
  await click(button("Open source Note"));
  expect(onOpenNote).toHaveBeenCalledWith(noteId);
  delay = false;
  await click(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Reopen Buy filters"]',
    )!,
  );
  await click(button("Open"));
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  expect(requests.some((path) => path.startsWith("/api/v1/notes/"))).toBe(
    false,
  );
});
it("sends dedicated server search/status filters and shows meaningful empty results", async () => {
  const input = container.querySelector<HTMLInputElement>("#task-query")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "invoice");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Search tasks"));
  expect(requests.some((url) => url.includes("q=invoice"))).toBe(true);
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  await click(button("Completed"));
  expect(container.textContent).toContain("No Tasks match this search.");
});
it("retains command identity after transport uncertainty and confirms exactly the same retry", async () => {
  failMutation = true;
  await click(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Complete Check invoice"]',
    )!,
  );
  expect(container.textContent).not.toContain("Private network error");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  failMutation = false;
  await click(button("Retry task change"));
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
});
it("reloads on revision conflict without completing anything and permits a deliberate fresh command", async () => {
  conflict = true;
  await click(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Complete Check invoice"]',
    )!,
  );
  expect(container.textContent).toContain("The Task changed");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  expect(tasks.every((t) => t.status === "OPEN")).toBe(true);
  conflict = false;
  await click(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Complete Check invoice"]',
    )!,
  );
  expect(commands[0]!.commandId).not.toBe(commands[1]!.commandId);
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
});

it("reuses a creation ID after an uncertain response and leaves no duplicate", async () => {
  const originalFetch = fetch;
  const creates: Array<{ taskId: string; title: string }> = [];
  vi.stubGlobal("fetch", async (raw: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return originalFetch(raw, init);
    const input = JSON.parse(String(init.body));
    creates.push(input);
    let task = tasks.find((t) => t.taskId === input.taskId);
    if (!task) {
      task = {
        ...tasks[0]!,
        taskId: input.taskId,
        title: input.title,
        description: null,
        sources: [],
      };
      tasks.push(task);
      throw new TypeError("Uncertain response after commit");
    }
    return json({ status: "DB_PERSISTED", task, replayed: true });
  });
  await click(container.querySelector("summary")!);
  const input = container.querySelector<HTMLInputElement>("#task-title")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "New explicit Task");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Create Task"));
  expect(input.disabled).toBe(true);
  await click(button("Retry Task creation"));
  expect(creates[0]).toEqual(creates[1]);
  expect(tasks.filter((t) => t.title === "New explicit Task")).toHaveLength(1);
  expect(container.textContent).toContain("Task saved.");
});

it("loads bounded server pages and restores the previous page", async () => {
  const originalFetch = fetch;
  vi.stubGlobal("fetch", async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(raw));
    if (url.pathname !== "/api/v1/tasks") return originalFetch(raw, init);
    const after = url.searchParams.get("after");
    requests.push(url.toString());
    return json(
      after
        ? { tasks: tasks.slice(2), nextCursor: null }
        : { tasks: tasks.slice(0, 2), nextCursor: ids[1] },
    );
  });
  await click(button("Refresh tasks"));
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  await click(button("Next Tasks"));
  expect(requests.some((url) => url.includes("after=" + ids[1]))).toBe(true);
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  await click(button("Previous Tasks"));
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
});

it.each([
  [401, "Your session expired"],
  [403, "Task access is missing"],
  [404, "Tasks are not enabled"],
])("shows an actionable safe failure for HTTP %s", async (status, message) => {
  vi.stubGlobal("fetch", async () =>
    json(
      {
        error: {
          code:
            status === 401
              ? "UNAUTHORIZED"
              : status === 403
                ? "FORBIDDEN"
                : "NOT_FOUND",
        },
      },
      status,
    ),
  );
  await click(button("Refresh tasks"));
  expect(container.textContent).toContain(message);
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(button("Retry Tasks")).toBeDefined();
});
