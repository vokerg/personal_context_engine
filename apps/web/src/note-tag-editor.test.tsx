// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const noteId = "01K00000000000000000000001";
const preview = {
  id: noteId,
  title: "Synthetic tag target",
  summary: "Only a synthetic example",
  capturedAt: "2026-10-22T18:00:00Z",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
let root: Root;
let container: HTMLDivElement;
let revision: number;
let tags: string[];
let added: string[];
let removed: string[];
let rejectNextWrite: boolean;
let detailReads: number;
const writes: Array<Record<string, unknown>> = [];

function editingState() {
  return {
    sourceTags: ["source-tag"],
    manualAdded: added,
    manualRemoved: removed,
    revision,
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent?.trim() === label,
  );
  if (!button) throw new Error("Missing synthetic button: " + label);
  await act(async () => {
    button.click();
  });
  await flush();
}

async function fill(id: string, value: string) {
  const element = container.querySelector<HTMLInputElement>("#" + id)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function connectAndOpen() {
  await act(async () => {
    root.render(
      <App
        baseUrl="https://api.example.test"
        localDevelopment={false}
      />,
    );
  });
  await fill("access-token", "synthetic-token");
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
  await click("Open note: Synthetic tag target");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/");
  revision = 0;
  tags = ["source-tag"];
  added = [];
  removed = [];
  rejectNextWrite = false;
  detailReads = 0;
  writes.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL | string, options?: RequestInit) => {
      const url = new URL(String(target));
      if (url.pathname === "/api/v1/tag-registry") {
        return response({ revision: 0, truncated: false, approved: [] });
      }
      if (url.pathname === "/api/v1/tags") {
        return response({
          tags: tags.map((slug) => ({ slug, count: 1 })),
          truncated: false,
        });
      }
      if (url.pathname === "/api/v1/notes") {
        return response({ notes: [{ ...preview, tags }] });
      }
      if (url.pathname === `/api/v1/notes/${noteId}/tags`) {
        const data = JSON.parse(String(options?.body)) as {
          operation: "add" | "remove";
          slug: string;
          expectedRevision: number;
        };
        writes.push(data);
        expect(options?.method).toBe("PATCH");
        if (rejectNextWrite) {
          rejectNextWrite = false;
          revision++;
          return response({ error: { code: "CONFLICT" } }, 409);
        }
        if (data.expectedRevision !== revision) {
          return response({ error: { code: "CONFLICT" } }, 409);
        }
        if (data.operation === "add") {
          tags = [...new Set([...tags, data.slug])].sort();
          added = data.slug === "source-tag" ? added : [data.slug];
          removed = removed.filter((item) => item !== data.slug);
        } else {
          tags = tags.filter((item) => item !== data.slug);
          added = added.filter((item) => item !== data.slug);
          removed = [...removed, data.slug];
        }
        revision++;
        return response({ tags, tagEditing: editingState(), changed: true });
      }
      if (url.pathname === `/api/v1/notes/${noteId}`) {
        detailReads++;
        return response({
          ...preview,
          tags,
          body: "Synthetic only",
          tagEditing: editingState(),
        });
      }
      return response({ error: { code: "NOT_FOUND" } }, 404);
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

describe("manual note tags", () => {
  it("adds free-form candidates, removes per-note source tags, and never approves a slug implicitly", async () => {
    await connectAndOpen();
    expect(container.textContent).toContain("Add a tag to this note");
    await fill("new-note-tag", "manual-tag");
    await click("Add tag");
    expect(writes[0]).toEqual({
      operation: "add",
      slug: "manual-tag",
      expectedRevision: 0,
    });
    expect(
      container.querySelector('[aria-label="Remove tag manual-tag from this note"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Approve note tag manual-tag"]'),
    ).not.toBeNull();
    await click("Remove tag source-tag from this note");
    expect(writes[1]).toEqual({
      operation: "remove",
      slug: "source-tag",
      expectedRevision: 1,
    });
    expect(tags).toEqual(["manual-tag"]);
    expect(editingState()).toMatchObject({
      revision: 2,
      sourceTags: ["source-tag"],
      manualRemoved: ["source-tag"],
    });
    expect(window.location.href).not.toContain("manual-tag");
  });

  it("reloads after a revision conflict without applying a stale local edit", async () => {
    await connectAndOpen();
    rejectNextWrite = true;
    await fill("new-note-tag", "new-tag");
    await click("Add tag");
    expect(writes).toHaveLength(1);
    expect(tags).toEqual(["source-tag"]);
    expect(detailReads).toBe(2);
    expect(container.textContent).toContain("Tags changed in another tab");
  });
});
