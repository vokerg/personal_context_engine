// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "@pce/api-client";
import type { MobileSession } from "./session";
import { paletteFor } from "./theme";
vi.mock("expo-crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000099",
}));
vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");
  type Props = {
    children?: React.ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: {
      checked?: boolean;
      disabled?: boolean;
      selected?: boolean;
    };
    style?: React.CSSProperties;
    onPress?: () => void;
    disabled?: boolean;
  };
  const host =
    (tag: string) =>
    ({
      children,
      accessibilityRole,
      accessibilityLabel,
      accessibilityState,
      onPress,
      disabled,
      style,
    }: Props) =>
      h(
        tag,
        {
          role: accessibilityRole,
          "aria-label": accessibilityLabel,
          "aria-checked": accessibilityState?.checked,
          "aria-selected": accessibilityState?.selected,
          disabled: disabled ?? accessibilityState?.disabled,
          onClick: onPress,
          ...(typeof style === "object" ? { style } : {}),
        },
        children,
      );
  return {
    View: host("div"),
    Text: host("span"),
    Pressable: host("button"),
    ScrollView: host("section"),
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      editable,
    }: {
      accessibilityLabel: string;
      value: string;
      editable?: boolean;
      onChangeText: (v: string) => void;
    }) =>
      h("input", {
        "aria-label": accessibilityLabel,
        value,
        disabled: editable === false,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
          onChangeText(e.target.value),
      }),
    FlatList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
      ListFooterComponent,
    }: {
      data: Task[];
      renderItem: (item: { item: Task }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    }) =>
      h(
        "section",
        { "data-native-list": true },
        ListHeaderComponent,
        ...data.map((item) =>
          h("div", { key: item.taskId }, renderItem({ item })),
        ),
        data.length ? null : ListEmptyComponent,
        ListFooterComponent,
      ),
  };
});
import { TasksScreen } from "./task-screen";
const noteId = "00000000-0000-4000-8000-000000000098";
let root: Root, container: HTMLDivElement, tasks: Task[], calls: string[];
const onOpenNote = vi.fn();
const json = (v: unknown) => new Response(JSON.stringify(v));
const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  onOpenNote.mockReset();
  tasks = [1, 2, 3].map((n) => ({
    taskId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `Synthetic Task ${n}`,
    description: null,
    status: "OPEN",
    revision: 1,
    completedAt: null,
    origin: "api",
    createdAt: "2026-10-25T10:00:00Z",
    updatedAt: "2026-10-25T10:00:00Z",
    sources: [
      {
        noteId,
        captureId: "00000000-0000-4000-8000-000000000097",
        capturedAt: "2026-10-24T10:00:00Z",
        evidence: "Synthetic original unchanged",
      },
    ],
    unavailableSourceCount: 0,
  }));
  vi.stubGlobal("fetch", async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(raw));
    calls.push(url.pathname + url.search);
    if (init?.method === "PATCH") {
      const input = JSON.parse(String(init.body));
      const task = tasks.find((t) => url.pathname.endsWith(t.taskId))!;
      task.status = input.status;
      task.completedAt =
        input.status === "COMPLETED" ? "2026-10-25T11:00:00Z" : null;
      task.revision++;
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
        q = url.searchParams.get("q");
      return json({
        tasks: tasks.filter(
          (t) =>
            (status === "ALL" || t.status === status) &&
            (!q || t.title.includes(q)),
        ),
        nextCursor: null,
      });
    }
    return json(tasks.find((t) => url.pathname.endsWith(t.taskId)));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const session = {
    config: { apiOrigin: "https://api.example" },
    getAccessToken: async () => "synthetic",
  } as unknown as MobileSession;
  await act(async () => {
    root.render(
      <TasksScreen
        session={session}
        palette={paletteFor("light", "light")}
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
const press = async (label: string) => {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .click(),
  );
  await flush();
};
it("uses native Task controls for completion, archive/reopen and original Note navigation", async () => {
  expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
  await press("Complete Synthetic Task 2");
  expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
  await press("Completed Tasks");
  expect(
    container.querySelector('[aria-label="Reopen Synthetic Task 2"]'),
  ).not.toBeNull();
  await press("Open Task: Synthetic Task 2");
  await press("Open source Note");
  expect(onOpenNote).toHaveBeenCalledWith(noteId);
  expect(container.textContent).toContain("Synthetic original unchanged");
  await press("Reopen Task");
  await press("Back to Tasks");
  await press("Open Tasks");
  expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
  expect(calls.some((url) => url.startsWith("/api/v1/notes/"))).toBe(false);
});
it("sends dedicated server search and offers explicit creation rather than extracting from dictation", async () => {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search Tasks"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Task 3");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Search Tasks");
  expect(calls.some((url) => url.includes("q=Task+3"))).toBe(true);
  expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
  await press("Create a Task");
  expect(
    container.querySelector('input[aria-label="Task title"]'),
  ).not.toBeNull();
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Save Task"]')!
      .disabled,
  ).toBe(true);
  expect(calls.every((url) => !url.includes("captures"))).toBe(true);
});
