// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovedTagCatalog } from "./ApprovedTagCatalog.js";
let root: Root, container: HTMLDivElement;
const tags = Array.from({ length: 205 }, (_, i) => ({
  slug: "synthetic-" + String(i).padStart(3, "0"),
  displayName: i === 204 ? "Hidden comet" : null,
  description: null,
  noteCount: 0,
  approvedAt: "2026-10-23T10:00:00Z",
}));
const urls: URL[] = [];
let changed = false;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  urls.length = 0;
  changed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL | string) => {
      const u = new URL(String(target));
      urls.push(u);
      if (changed && u.searchParams.has("after"))
        return new Response(JSON.stringify({ error: { code: "CONFLICT" } }), {
          status: 409,
        });
      const q = u.searchParams.get("q")?.toLowerCase() ?? "",
        after = u.searchParams.get("after") ?? "";
      const filtered = tags.filter(
          (t) =>
            (t.slug + " " + t.displayName).toLowerCase().includes(q) &&
            t.slug > after,
        ),
        page = filtered.slice(0, 50);
      return new Response(
        JSON.stringify({
          revision: changed ? 2 : 1,
          approved: page,
          truncated: filtered.length > 50,
          nextCursor: filtered.length > 50 ? page.at(-1)!.slug : null,
        }),
      );
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    root.render(
      <ApprovedTagCatalog
        baseUrl="https://api.example.test"
        token="synthetic"
        useSessionCookie={false}
        registry={{ revision: 1, approved: [], truncated: true }}
        selectTag={() => {}}
      />,
    );
  });
  await flush();
}
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  )!;
  await act(async () => button.click());
  await flush();
}
it("pages through more than 200 approvals and searches the full server catalog", async () => {
  await render();
  expect(container.textContent).toContain("Page 1 · 50 tags");
  for (let i = 0; i < 4; i++) await click("Next tags");
  expect(container.textContent).toContain("Hidden comet");
  expect(container.textContent).toContain("Page 5");
  expect(document.activeElement?.textContent).toBe("Browse approved tags");
  expect(
    container.querySelector('[aria-label="Unapprove tag synthetic-204"]'),
  ).toBeNull();
  expect(container.querySelectorAll(".tag-check")).toHaveLength(5);
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "comet");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  await flush();
  expect(urls.at(-1)?.searchParams.get("q")).toBe("comet");
  expect(urls.at(-1)?.searchParams.has("after")).toBe(false);
  expect(container.textContent).toContain("Hidden comet");
  expect(container.querySelector(".tag-status-approved")).toBeNull();
});
it("restarts at the first page if a concurrent mutation invalidates the catalog revision", async () => {
  await render();
  changed = true;
  await click("Next tags");
  await flush();
  expect(container.textContent).toContain("The approved catalog changed");
  expect(container.textContent).toContain("Page 1");
  expect(urls.at(-1)?.searchParams.has("after")).toBe(false);
});
