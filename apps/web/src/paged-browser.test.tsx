// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { App } from "./App.js";

let root: Root, container: HTMLDivElement;
let storageWrite: ReturnType<typeof vi.spyOn>;
const requests: URL[] = [];
const id = (n: number) => String(n).padStart(26, "0");
const notes = Array.from({ length: 48 }, (_, i) => ({
  id: id(i + 1),
  title: `Synthetic note ${i + 1}`,
  summary: "Preview without a body keyword",
  tags: ["observed"],
  capturedAt: "2026-10-18T10:00:00Z",
}));
const metadata = {
  capturedAtRaw: "2026-10-18T12:00:00+02:00",
  source: "import",
  kind: "memo",
  domains: ["synthetic"],
  projects: ["project-local"],
  actionHint: "remind",
  reviewRequired: true,
  occurredAt: null,
  dueAt: "2026-10-20T10:00:00+02:00",
  timezone: "Europe/Copenhagen",
};
async function flush(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text || b.getAttribute("aria-label") === text,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await flush();
}
async function input(name: string, value: string) {
  const el = container.querySelector<HTMLInputElement>("#" + name)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}
async function connect() {
  await act(async () =>
    root.render(
      <App
        browseEnabled
        localDevelopment={false}
        baseUrl="https://api.example.test"
      />,
    ),
  );
  await input("access-token", "synthetic-token");
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storageWrite = vi.spyOn(window.Storage.prototype, "setItem");
  window.history.replaceState(null, "", "/");
  requests.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL | string) => {
      const url = new URL(String(target));
      requests.push(url);
      if (url.pathname === "/api/v1/tags")
        return response({
          tags: [{ slug: "observed", count: 48 }],
          truncated: false,
        });
      if (url.pathname === "/api/v1/browse/facets")
        return response({
          projects: [{ slug: "project-local", count: 48 }],
          kinds: [{ slug: "memo", count: 48 }],
          truncated: false,
        });
      if (url.pathname === "/api/v1/browse")
        return response(
          url.searchParams.has("q")
            ? { notes: [notes[47]], nextCursor: null }
            : url.searchParams.has("cursor")
              ? { notes: notes.slice(24), nextCursor: null }
              : { notes: notes.slice(0, 24), nextCursor: "next-synthetic" },
        );
      return response({
        ...notes.find((n) => url.pathname.endsWith(n.id))!,
        body: "# Synthetic\n<script>untrusted()</script>",
        originalInput: "Verbatim <img src=x onerror=untrusted()> 🧪",
        metadata,
      });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("fetches bounded pages, preserves page/detail/back and exposes safe original/structured metadata", async () => {
  await connect();
  expect(requests.some((r) => r.pathname === "/api/v1/notes")).toBe(false);
  expect(container.querySelectorAll(".note-button").length).toBe(24);
  await act(async () => {
    container.querySelector<HTMLInputElement>("#project-filter")!.focus();
  });
  expect(
    container.querySelector('[aria-label="Project suggestions"]')?.textContent,
  ).toContain("project-local (48)");
  expect(container.querySelector("datalist")).toBeNull();
  expect(container.querySelector("#kind-filter")?.textContent).toContain(
    "memo (48)",
  );
  const status = container.querySelector<HTMLSelectElement>("#status-filter")!;
  expect([...status.options].map((option) => option.value)).toEqual([
    "active",
    "archived",
    "all",
  ]);
  await act(async () => {
    status.value = "archived";
    status.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  expect(
    requests
      .filter((request) => request.pathname === "/api/v1/browse")
      .at(-1)
      ?.searchParams.get("status"),
  ).toBe("archived");
  await click("Next page");
  expect(container.textContent).toContain("Page 2");
  expect(container.querySelectorAll(".note-button").length).toBe(24);
  expect(
    container.querySelector('[aria-label="Open note: Synthetic note 1"]'),
  ).toBeNull();
  await click("Open note: Synthetic note 25");
  expect(container.textContent).toContain("Verbatim <img");
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("No notification scheduled");
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await flush();
  expect(container.textContent).toContain("Page 2");
  expect(document.activeElement?.id).toBe("timeline");
  await act(async () => {
    window.history.forward();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await flush();
  expect(container.textContent).toContain("Verbatim <img");
  await click("← Back to timeline");
  expect(container.textContent).toContain("Page 2");
  expect(document.activeElement?.id).toBe("timeline");
  await click("Previous page");
  expect(container.textContent).toContain("Page 1");
  expect(window.location.href).not.toContain("next-synthetic");
});
it("searches full-text results without filtering them again by previews, resets cursors and keeps text out of address/storage", async () => {
  await connect();
  await click("Next page");
  await input("note-query", "body-needle");
  await flush(300);
  const search = requests
    .filter((r) => r.pathname === "/api/v1/browse")
    .at(-1)!;
  expect(search.searchParams.get("q")).toBe("body-needle");
  expect(search.searchParams.has("cursor")).toBe(false);
  expect(container.querySelectorAll(".note-button").length).toBe(1);
  expect(container.textContent).toContain("Synthetic note 48");
  expect(window.location.href).not.toContain("body-needle");
  expect(storageWrite).not.toHaveBeenCalled();
  await click("Reset filters");
  await flush(300);
  expect(container.querySelectorAll(".note-button").length).toBe(24);
  await click("Clear session");
  expect(container.textContent).not.toContain("project-local");
  expect(container.textContent).not.toContain("Synthetic note 48");
});
it("cancels stale page responses and recovers from a cursor invalidated by a changed source snapshot", async () => {
  await connect();
  const normalFetch = fetch;
  let release: ((r: Response) => void) | undefined,
    oldSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL | string, options?: RequestInit) => {
      const url = new URL(String(target));
      if (url.searchParams.has("cursor")) {
        oldSignal = options?.signal;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return normalFetch(target, options);
    }),
  );
  await click("Next page");
  await input("project-filter", "project-local");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {
    release?.(response({ notes: notes.slice(24), nextCursor: null }));
  });
  await flush();
  expect(container.textContent).toContain("Synthetic note 1");
  expect(container.textContent).toContain("Page 1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL | string, options?: RequestInit) =>
      new URL(String(target)).searchParams.has("cursor")
        ? response({ error: { code: "BAD_REQUEST" } }, 400)
        : normalFetch(target, options),
    ),
  );
  await click("Next page");
  expect(container.textContent).toContain("snapshot changed");
  expect(container.textContent).toContain("Page 1");
});

it("bounds project suggestions, narrows matches and applies keyboard selection or a typed slug", async () => {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((target: URL | string, options?: RequestInit) => {
      if (new URL(String(target)).pathname === "/api/v1/browse/facets")
        return Promise.resolve(
          response({
            projects: Array.from({ length: 20 }, (_, i) => ({
              slug: `project-${i}`,
              count: 1,
            })),
            kinds: [],
            truncated: false,
          }),
        );
      return originalFetch(target, options);
    }),
  );
  await connect();
  const project = container.querySelector<HTMLInputElement>("#project-filter")!;
  await act(async () => {
    project.focus();
  });
  expect(
    container.querySelectorAll(
      '[aria-label="Project suggestions"] [role="option"]',
    ),
  ).toHaveLength(6);
  await input("project-filter", "project-19");
  expect(
    container.querySelectorAll(
      '[aria-label="Project suggestions"] [role="option"]',
    ),
  ).toHaveLength(2);
  await act(async () => {
    project.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  await act(async () => {
    project.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  await act(async () => {
    project.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await flush();
  expect(project.value).toBe("project-19");
  expect(project.getAttribute("aria-expanded")).toBe("false");
  expect(
    requests
      .filter((r) => r.pathname === "/api/v1/browse")
      .at(-1)
      ?.searchParams.get("project"),
  ).toBe("project-19");
  await input("project-filter", "outside-facets");
  expect(
    requests
      .filter((r) => r.pathname === "/api/v1/browse")
      .at(-1)
      ?.searchParams.get("project"),
  ).toBe("outside-facets");
  await click("Reset filters");
  expect(project.value).toBe("");
});
