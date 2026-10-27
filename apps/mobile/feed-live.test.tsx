// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const server = vi.hoisted(() => ({
  title: "Before worker import",
  browse: vi.fn(),
  facets: vi.fn(),
  registry: vi.fn(),
  change: vi.fn<(state: string) => void>(),
}));
vi.mock("@pce/api-client", async (original) => ({
  ...(await original<typeof import("@pce/api-client")>()),
  getBrowsePage: server.browse,
  getBrowseFacets: server.facets,
  getTagRegistry: server.registry,
}));
vi.mock("react-native", () => {
  const host = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return {
    View: host,
    Text: host,
    ScrollView: host,
    TextInput: () => null,
    AppState: {
      currentState: "active",
      addEventListener: (_event: string, fn: (state: string) => void) => {
        server.change.mockImplementation(fn);
        return { remove: vi.fn() };
      },
    },
    Pressable: ({
      children,
      onPress,
    }: {
      children?: React.ReactNode;
      onPress: () => void;
    }) => React.createElement("button", { onClick: onPress }, children),
    RefreshControl: ({ onRefresh }: { onRefresh: () => void }) =>
      React.createElement("button", {
        onClick: onRefresh,
        "aria-label": "Pull to refresh",
      }),
    FlatList: ({
      data,
      renderItem,
      refreshControl,
      ListEmptyComponent,
    }: {
      data: unknown[];
      renderItem: (item: { item: unknown }) => React.ReactNode;
      refreshControl?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) =>
      React.createElement(
        "section",
        null,
        refreshControl,
        data.length
          ? data.map((item, i) =>
              React.createElement("div", { key: i }, renderItem({ item })),
            )
          : ListEmptyComponent,
      ),
  };
});
import { TimelineScreen } from "./feed-screens";
import { paletteFor } from "./theme";
import type { MobileSession } from "./session";
let root: ReturnType<typeof createRoot>;
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
it("shows newly imported server data without a relaunch and refreshes facets on pull-down", async () => {
  vi.useFakeTimers();
  server.browse.mockImplementation(async () => ({
    notes: [
      {
        id: "01K00000000000000000000001",
        title: server.title,
        summary: "Synthetic",
        capturedAt: "2026-10-27T10:00:00Z",
      },
    ],
    nextCursor: null,
  }));
  server.facets.mockResolvedValue({
    projects: [],
    kinds: [],
    truncated: false,
  });
  server.registry.mockResolvedValue({
    approved: [],
    revision: 1,
    nextCursor: null,
    truncated: false,
  });
  const container = document.createElement("div");
  root = createRoot(container);
  const props = {
    session: { config: { apiOrigin: "https://api.example" } } as MobileSession,
    palette: paletteFor("light", "light"),
    onOpenNote: vi.fn(),
  };
  await act(async () =>
    root.render(React.createElement(TimelineScreen, props)),
  );
  expect(container.textContent).toContain("Before worker import");
  server.title = "Imported while app is running";
  await act(async () => vi.advanceTimersByTime(30000));
  expect(container.textContent).toContain("Imported while app is running");
  expect(container.textContent).not.toContain("Before worker import");
  server.title = "Latest on pull";
  const facetsBefore = server.facets.mock.calls.length;
  await act(async () =>
    (
      container.querySelector(
        '[aria-label="Pull to refresh"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(container.textContent).toContain("Latest on pull");
  expect(server.facets.mock.calls.length).toBe(facetsBefore + 1);
  const calls = server.browse.mock.calls.length;
  await act(async () =>
    root.render(
      React.createElement(TimelineScreen, { ...props, hidden: true }),
    ),
  );
  await act(async () => vi.advanceTimersByTime(60000));
  expect(server.browse).toHaveBeenCalledTimes(calls);
  server.title = "Updated in background";
  await act(async () =>
    root.render(React.createElement(TimelineScreen, props)),
  );
  expect(container.textContent).toContain("Updated in background");
});
