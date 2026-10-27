// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  change: vi.fn<(state: string) => void>(),
  remove: vi.fn(),
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, fn: (state: string) => void) => {
      native.change.mockImplementation(fn);
      return { remove: native.remove };
    },
  },
}));
import { useLiveRefresh } from "./live-refresh";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: ReturnType<typeof createRoot>;
function Screen({
  visible,
  refresh,
}: {
  visible: boolean;
  refresh: () => void;
}) {
  useLiveRefresh(visible, refresh);
  return null;
}
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
it("refreshes the visible screen, pauses in background, resumes once, and cleans up hidden screens", async () => {
  vi.useFakeTimers();
  root = createRoot(document.createElement("div"));
  const refresh = vi.fn();
  await act(async () =>
    root.render(React.createElement(Screen, { visible: true, refresh })),
  );
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(30000));
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => {
    native.change("background");
    vi.advanceTimersByTime(60000);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => {
    native.change("active");
    native.change("active");
  });
  expect(refresh).toHaveBeenCalledTimes(3);
  const latest = vi.fn();
  await act(async () =>
    root.render(
      React.createElement(Screen, { visible: true, refresh: latest }),
    ),
  );
  await act(async () => vi.advanceTimersByTime(30000));
  expect(latest).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(
      React.createElement(Screen, { visible: false, refresh: latest }),
    ),
  );
  await act(async () => vi.advanceTimersByTime(60000));
  expect(latest).toHaveBeenCalledOnce();
  expect(native.remove).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(
      React.createElement(Screen, { visible: true, refresh: latest }),
    ),
  );
  expect(latest).toHaveBeenCalledTimes(2);
});
