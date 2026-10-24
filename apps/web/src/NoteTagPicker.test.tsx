// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NoteTagPicker } from "./NoteTagPicker.js";

let container: HTMLDivElement;
let root: Root;
const requests: URL[] = [];
function Fixture() {
  const [value, onChange] = useState("");
  return (
    <>
      <label htmlFor="new-note-tag">Add a tag to this note</label>
      <NoteTagPicker
        value={value}
        onChange={onChange}
        disabled={false}
        attached={["already-attached"]}
        baseUrl="https://api.example.test"
        token="synthetic-token"
        useSessionCookie={false}
        revision={1}
      />
      <button>Outside</button>
    </>
  );
}
const registry = (slugs: string[]) => ({
  revision: 1,
  truncated: true,
  approved: slugs.map((slug) => ({
    slug,
    displayName: null,
    description: null,
    noteCount: 1,
    approvedAt: "2026-10-24T05:00:00Z",
  })),
});
const input = () => container.querySelector<HTMLInputElement>("input")!;
async function focus() {
  await act(async () => {
    input().focus();
  });
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
}
async function key(value: string) {
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true }),
    );
  });
}
async function fill(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) => {
      const parsed = new URL(String(url));
      requests.push(parsed);
      const slugs = parsed.searchParams.has("q")
        ? ["remote-approved"]
        : [
            "already-attached",
            ...Array.from({ length: 20 }, (_, i) => `approved-${i}`),
          ];
      return new Response(JSON.stringify(registry(slugs)));
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Fixture />);
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("shows six approved suggestions, excludes attached tags and supports keyboard selection and dismissal", async () => {
  expect(requests).toHaveLength(0);
  expect(container.querySelector("datalist")).toBeNull();
  await focus();
  await tick();
  expect(requests[0]!.pathname).toBe("/api/v1/tag-registry");
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(6);
  expect(
    container.querySelector('[role="listbox"]')?.textContent,
  ).not.toContain("already-attached");
  await key("ArrowDown");
  const active = document.getElementById(
    input().getAttribute("aria-activedescendant")!,
  );
  expect(active?.textContent).toBe("approved-0");
  await key("Enter");
  expect(input().value).toBe("approved-0");
  expect(input().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(input());
  await key("ArrowDown");
  expect(input().getAttribute("aria-expanded")).toBe("true");
  await key("Escape");
  expect(input().getAttribute("aria-expanded")).toBe("false");
});
it("searches the full approved catalog and keeps free-form entry explicit", async () => {
  await focus();
  await tick();
  await fill("remote");
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
  await tick();
  expect(requests.at(-1)?.searchParams.get("q")).toBe("remote");
  const option = container.querySelector<HTMLButtonElement>('[role="option"]')!;
  expect(option.textContent).toBe("remote-approved");
  await act(async () => {
    option.click();
  });
  expect(input().value).toBe("remote-approved");
  await fill("new-candidate");
  await key("Escape");
  expect(input().value).toBe("new-candidate");
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Outside")!
      .focus();
  });
  expect(input().getAttribute("aria-expanded")).toBe("false");
});
it("ignores a late response after query changes or the picker unmounts", async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
  );
  await focus();
  await tick();
  await fill("new");
  await tick();
  await act(async () => {
    pending[1]!(new Response(JSON.stringify(registry(["new-approved"]))));
  });
  await act(async () => {
    pending[0]!(new Response(JSON.stringify(registry(["stale-approved"]))));
  });
  expect(container.querySelector('[role="listbox"]')?.textContent).toBe(
    "new-approved",
  );
  await fill("late");
  await tick();
  await act(async () => {
    root.render(null);
  });
  await act(async () => {
    pending[2]!(new Response(JSON.stringify(registry(["late-approved"]))));
  });
  expect(container.textContent).toBe("");
});
