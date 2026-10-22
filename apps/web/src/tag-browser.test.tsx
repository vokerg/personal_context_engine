// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const first = {
  id: "01K00000000000000000000001",
  title: "Synthetic alpha",
  summary: "First synthetic summary",
  capturedAt: "2026-10-17T10:00:00Z",
  tags: ["focus"],
};
const second = {
  id: "01K00000000000000000000002",
  title: "Synthetic beta",
  summary: "Second synthetic summary",
  capturedAt: "2026-10-16T10:00:00Z",
  tags: ["other"],
};
let root: Root;
let container: HTMLDivElement;
let tagFailure: boolean;
let emptyTags: boolean;
let truncated: boolean;
let approvedSlugs: string[] = [];
let registryRevision = 0;
const requests: URL[] = [];

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error("Missing synthetic test control: " + label);
  await act(async () => {
    button.click();
  });
  await flush();
}
async function input(id: string, value: string) {
  const element = container.querySelector<HTMLInputElement>("#" + id)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}
async function connect() {
  await act(async () => {
    root.render(
      <App baseUrl="https://api.example.test" localDevelopment={false} />,
    );
  });
  await input("access-token", "synthetic-token");
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}
const openNote = () =>
  container.querySelector(
    '[aria-label="Open note: Synthetic alpha"]',
  ) as HTMLButtonElement | null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/");
  requests.length = 0;
  tagFailure = false;
  emptyTags = false;
  truncated = false;
  approvedSlugs = [];
  registryRevision = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL | string, options?: RequestInit) => {
      const url = new URL(String(target));
      requests.push(url);
      if (url.pathname === "/api/v1/tag-registry") {
        return new Response(
          JSON.stringify({
            revision: registryRevision,
            truncated: false,
            approved: approvedSlugs.map((slug) => ({
              slug,
              displayName: null,
              description: null,
              noteCount: slug === "focus" || slug === "other" ? 1 : 0,
              approvedAt: "2026-10-22T08:00:00Z",
            })),
          }),
        );
      }
      if (url.pathname.startsWith("/api/v1/tag-registry/")) {
        const slug = decodeURIComponent(url.pathname.split("/").pop()!);
        const approved = options?.method === "PUT";
        const changed = approved
          ? !approvedSlugs.includes(slug)
          : approvedSlugs.includes(slug);
        if (changed) {
          approvedSlugs = approved
            ? [...approvedSlugs, slug].sort()
            : approvedSlugs.filter((item) => item !== slug);
          registryRevision++;
        }
        return new Response(
          JSON.stringify({
            slug,
            approved,
            changed,
            revision: registryRevision,
          }),
        );
      }
      if (url.pathname === "/api/v1/tags") {
        return new Response(
          JSON.stringify(
            tagFailure
              ? { error: { code: "SERVICE_UNAVAILABLE" } }
              : {
                  tags: emptyTags
                    ? []
                    : [
                        { slug: "focus", count: 1 },
                        { slug: "other", count: 1 },
                      ],
                  truncated,
                },
          ),
          { status: tagFailure ? 503 : 200 },
        );
      }
      if (url.pathname === "/api/v1/notes") {
        return new Response(
          JSON.stringify({
            notes: [first, second].filter(
              (note) =>
                !url.searchParams.has("tag") ||
                note.tags.includes(url.searchParams.get("tag")!),
            ),
          }),
        );
      }
      return new Response(
        JSON.stringify({
          ...first,
          body: "Synthetic original",
          tags: ["focus"],
        }),
      );
    }),
  );
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("interactive observed tag browser", () => {
  it("does not fetch or restore an old owner's registry after signout during approval", async () => {
    await connect();
    const originalFetch = fetch;
    let releaseWrite: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((target: URL | string, options?: RequestInit) => {
        const url = new URL(String(target));
        if (
          url.pathname === "/api/v1/tag-registry/focus" &&
          options?.method === "PUT"
        ) {
          return new Promise<Response>((resolve) => {
            releaseWrite = resolve;
          });
        }
        return originalFetch(target, options);
      }),
    );
    await click("Approve tag focus");
    expect(releaseWrite).toBeDefined();
    const readsBeforeLogout = requests.filter(
      (item) => item.pathname === "/api/v1/tag-registry",
    ).length;
    await click("Clear session");
    await act(async () => {
      releaseWrite?.(
        new Response(
          JSON.stringify({
            slug: "focus",
            approved: true,
            changed: true,
            revision: 1,
          }),
        ),
      );
    });
    await flush();
    expect(
      requests.filter((item) => item.pathname === "/api/v1/tag-registry"),
    ).toHaveLength(readsBeforeLogout);
    expect(container.textContent).toContain("Sign-in required");
    expect(container.textContent).not.toContain("Approved vocabulary");
  });
  it("keeps filtering separate from explicit approval and reversible vocabulary changes", async () => {
    await connect();
    expect(
      container.querySelector('[aria-label="Approve tag focus"]'),
    ).not.toBeNull();
    await click("Approve tag focus");
    expect(
      container.querySelector('[aria-label="Approve tag focus"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Unapprove tag focus"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Approved vocabulary · revision 1");
    await click("Filter by tag focus, 1 notes");
    expect(
      container.querySelector('[aria-label="Open note: Synthetic beta"]'),
    ).toBeNull();
    await click("Unapprove tag focus");
    expect(
      container.querySelector('[aria-label="Approve tag focus"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Approved vocabulary · revision 2");
    expect(
      requests.filter((r) => r.pathname.startsWith("/api/v1/tag-registry/"))
        .length,
    ).toBe(2);
  });
  it("combines API facets with local search/date filters, preserves detail/back, shares only on request and resets", async () => {
    await connect();
    expect(container.textContent).toContain("Your tags");
    expect(
      container.querySelector('[aria-label="Filter by tag focus, 1 notes"]'),
    ).not.toBeNull();
    await click("Filter by tag focus, 1 notes");
    expect(requests.at(-1)?.searchParams.get("tag")).toBe("focus");
    expect(window.location.search).toBe("");
    expect(
      container.querySelector('[aria-label="Open note: Synthetic beta"]'),
    ).toBeNull();
    await input("project-filter", "demo");
    const kind = container.querySelector<HTMLSelectElement>("#kind-filter")!;
    await act(async () => {
      kind.value = "memo";
      kind.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(requests.at(-1)?.searchParams.get("project")).toBe("demo");
    expect(requests.at(-1)?.searchParams.get("kind")).toBe("memo");
    await input("note-query", "alpha");
    await input("from-date", "2026-10-17");
    expect(requests.at(-1)?.searchParams.has("from")).toBe(false);
    await click("Open note: Synthetic alpha");
    expect(container.textContent).toContain("Synthetic original");
    expect(
      container.querySelector('[aria-label="Note tags"] button')?.textContent,
    ).toBe("focus");
    await click("← Back to timeline");
    expect(document.activeElement?.id).toBe("timeline-title");
    expect(
      container.querySelector<HTMLInputElement>("#note-query")?.value,
    ).toBe("alpha");
    expect(
      container.querySelector<HTMLInputElement>("#project-filter")?.value,
    ).toBe("demo");
    await click("Share filtered view");
    expect(new URL(window.location.href).searchParams.get("tag")).toBe("focus");
    expect(window.location.href).not.toContain("alpha");
    expect(window.location.href).not.toContain("synthetic-token");
    await click("Reset filters");
    expect(window.location.search).toBe("");
    expect(
      container.querySelector('[aria-label="Open note: Synthetic beta"]'),
    ).not.toBeNull();
    await click("Clear session");
    expect(container.textContent).not.toContain("focus");
    expect(window.location.search).toBe("");
  });
  it("restores tag context on browser back and forward, and note chips select actual metadata", async () => {
    await connect();
    const chip = container.querySelector(
      '[aria-label="Tags on Synthetic alpha"] button',
    ) as HTMLButtonElement;
    await act(async () => {
      chip.click();
    });
    await flush();
    await click("Open note: Synthetic alpha");
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await flush();
    expect(
      container
        .querySelector('[aria-label="Filter by tag focus, 1 notes"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).not.toContain("Synthetic original");
    await act(async () => {
      window.history.forward();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await flush();
    expect(container.textContent).toContain("Synthetic original");
    expect(openNote()).not.toBeNull();
  });
  it("keeps notes usable during tag errors, retries, and reports empty and capped catalogs", async () => {
    tagFailure = true;
    await connect();
    expect(openNote()).not.toBeNull();
    expect(container.textContent).toContain(
      "The API is temporarily unavailable.",
    );
    tagFailure = false;
    emptyTags = true;
    await click("Retry tags");
    expect(container.textContent).toContain("No tags yet.");
    emptyTags = false;
    truncated = true;
    await click("Refresh notes");
    expect(container.textContent).toContain("Showing the first 200 tags");
    await input("note-query", "no-matching-synthetic-text");
    expect(container.textContent).toContain("No matching notes");
  });
});

it("cancels an older tag request and ignores its late result", async () => {
  await connect();
  const standardFetch = fetch;
  let release: ((response: Response) => void) | undefined;
  let oldSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL | string, options?: RequestInit) => {
      const url = new URL(String(target));
      if (
        url.pathname === "/api/v1/notes" &&
        url.searchParams.get("tag") === "focus"
      ) {
        oldSignal = options?.signal;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return standardFetch(target, options);
    }),
  );
  await click("Filter by tag focus, 1 notes");
  await click("Filter by tag other, 1 notes");
  expect(oldSignal?.aborted).toBe(true);
  expect(openNote()).toBeNull();
  await act(async () => {
    release?.(new Response(JSON.stringify({ notes: [first] })));
  });
  await flush();
  expect(openNote()).toBeNull();
  expect(
    container.querySelector('[aria-label="Open note: Synthetic beta"]'),
  ).not.toBeNull();
});

it("loads a validated shared filter, supports an old untagged DTO and clears metadata on session expiry", async () => {
  window.history.replaceState(null, "", "/?tag=focus&kind=memo");
  const normalFetch = fetch;
  let expired = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL | string, options?: RequestInit) => {
      const url = new URL(String(target));
      if (expired)
        return new Response(
          JSON.stringify({ error: { code: "UNAUTHORIZED" } }),
          { status: 401 },
        );
      if (url.pathname === "/api/v1/notes") {
        const { tags: _tags, ...legacy } = first;
        void _tags;
        return new Response(JSON.stringify({ notes: [legacy] }));
      }
      return normalFetch(target, options);
    }),
  );
  await connect();
  expect(
    container
      .querySelector('[aria-label="Filter by tag focus, 1 notes"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(openNote()).not.toBeNull();
  expect(
    container.querySelector('[aria-label="Tags on Synthetic alpha"]'),
  ).toBeNull();
  expired = true;
  await click("Refresh notes");
  expect(container.textContent).toContain("Sign-in required");
  expect(container.textContent).not.toContain("Synthetic alpha");
  expect(container.textContent).not.toContain("focus");
  expect(window.location.search).toBe("");
});
