// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NoteTasks } from "./NoteTasks.js";
const noteId = "11111111-1111-4111-8111-111111111111";
const captureId = "22222222-2222-4222-8222-222222222222";
const tasks = [
  "Fix form",
  "Add navigation",
  "Repair pagination",
  "Investigate slow import",
  "Add cursor",
].map((title, i) => ({
  taskId: `33333333-3333-4333-8333-33333333333${i}`,
  title,
  evidence: title,
}));
let root: Root, container: HTMLDivElement;
const json = (value: unknown) => new Response(JSON.stringify(value));
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const button = (text: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  )!;
const click = async (text: string) => {
  await act(async () => button(text).click());
  await flush();
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.cookie = "pce_csrf=synthetic";
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(id = noteId) {
  await act(async () =>
    root.render(
      <NoteTasks
        key={id}
        noteId={id}
        baseUrl="https://api.example.test"
        token="cookie"
        useSessionCookie
      />,
    ),
  );
  await flush();
}
it("reviews five suggestions, saves selected tasks with CSRF and retries exact payload after uncertainty", async () => {
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.credentials).toBe("include");
      if (url.pathname.endsWith("/config"))
        return json({ enabled: true, provider: "DeepSeek" });
      expect(init.headers).toMatchObject({ "X-PCE-CSRF": "synthetic" });
      if (url.pathname.endsWith("/task-suggestions"))
        return json({
          noteId,
          captureId,
          model: "synthetic",
          tasks,
          reason: "",
        });
      writes.push(String(init.body));
      if (writes.length === 1) throw new Error("private transport error");
      const input = JSON.parse(String(init.body));
      return json({
        receipts: input.tasks.map((t: (typeof tasks)[number]) => ({
          status: "DB_PERSISTED",
          replayed: true,
          task: {
            taskId: t.taskId,
            title: t.title,
            description: null,
            status: "COMPLETED",
            revision: 2,
            createdAt: "2026-11-01T00:00:00Z",
            updatedAt: "2026-11-01T00:00:00Z",
            completedAt: "2026-11-01T00:00:00Z",
            origin: "api",
            sources: [],
            unavailableSourceCount: 0,
          },
        })),
      });
    }),
  );
  await render();
  expect(container.textContent).toContain("original text to DeepSeek");
  await click("Suggest tasks");
  expect(container.querySelectorAll("fieldset")).toHaveLength(5);
  await act(async () =>
    (
      container.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click(),
  );
  await click("Save 4 tasks");
  expect(container.textContent).toContain("Save was not confirmed");
  expect(container.textContent).not.toContain("private transport error");
  expect(
    [...container.querySelectorAll("fieldset")].every((f) => f.disabled),
  ).toBe(true);
  await click("Retry saving tasks");
  expect(writes).toHaveLength(2);
  expect(writes[0]).toBe(writes[1]);
  expect(JSON.parse(writes[0]!).tasks).toHaveLength(4);
  expect(container.textContent).toContain("4 tasks saved");
});
it("does not expose a disabled feature or create anything for zero suggestions", async () => {
  const request = vi.fn(async (url: URL) =>
    url.pathname.endsWith("/config")
      ? json({ enabled: true, provider: "DeepSeek" })
      : json({
          noteId,
          captureId,
          model: "synthetic",
          tasks: [],
          reason: "Only an idea.",
        }),
  );
  vi.stubGlobal("fetch", request);
  await render();
  await click("Suggest tasks");
  expect(container.textContent).toContain(
    "No clear tasks found. Only an idea.",
  );
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(request).toHaveBeenCalledTimes(2);
  request.mockImplementation(async () =>
    json({ enabled: false, provider: "DeepSeek" }),
  );
  await render(captureId);
  expect(container.textContent).toBe("");
});
it("blocks duplicate suggestion clicks and ignores late output after changing the source", async () => {
  let release: (value: Response) => void = () => {};
  let suggestions = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/config"))
        return json({ enabled: true, provider: "DeepSeek" });
      suggestions++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  await render();
  await act(async () => {
    button("Suggest tasks").click();
    button("Suggest tasks").click();
  });
  await flush();
  expect(suggestions).toBe(1);
  await render(captureId);
  release(json({ noteId, captureId, model: "synthetic", tasks, reason: "" }));
  await flush();
  expect(container.querySelectorAll("fieldset")).toHaveLength(0);
});
