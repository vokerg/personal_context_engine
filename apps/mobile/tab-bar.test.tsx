// @vitest-environment jsdom
import * as React from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock("react-native-bottom-tabs", () => ({
  useBottomTabBarHeight: () => 97,
  default: (props: {
    navigationState: {
      index: number;
      routes: { key: string; title: string }[];
    };
    onIndexChange: (index: number) => void;
    renderScene: (props: {
      route: { key: string; title: string };
    }) => React.ReactNode;
    tabBarHidden: boolean;
  }) => {
    native.props = props;
    return React.createElement(
      "div",
      null,
      !props.tabBarHidden &&
        React.createElement(
          "nav",
          { "aria-label": "System tabs" },
          props.navigationState.routes.map((route, i) =>
            React.createElement(
              "button",
              {
                key: route.key,
                onClick: () => props.onIndexChange(i),
                "aria-selected": props.navigationState.index === i,
              },
              route.title,
            ),
          ),
        ),
      props.navigationState.routes.map((route) =>
        React.createElement(
          "section",
          { key: route.key },
          props.renderScene({ route }),
        ),
      ),
    );
  },
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));
import { NativeTabs } from "./tab-bar";
import { paletteFor } from "./theme";
import type { MobileTab } from "./navigation";
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: ReturnType<typeof createRoot>;
const container = document.createElement("div");
afterEach(async () => {
  await act(async () => root.unmount());
});
function Content({ tab, inset }: { tab: MobileTab; inset: number }) {
  const [count, setCount] = useState(0);
  return (
    <button
      aria-label={tab + " content"}
      data-inset={inset}
      onClick={() => setCount((n) => n + 1)}
    >
      {count}
    </button>
  );
}
function Harness({
  tasksEnabled = false,
  hidden = false,
}: {
  tasksEnabled?: boolean;
  hidden?: boolean;
}) {
  const [active, setActive] = useState<MobileTab>("notes");
  return (
    <NativeTabs
      active={active}
      onSelect={setActive}
      palette={paletteFor("light", "light")}
      tasksEnabled={tasksEnabled}
      hidden={hidden}
      renderScene={(tab, inset) => <Content tab={tab} inset={inset} />}
    />
  );
}
it("uses system tab metadata, separate Search role and native measured insets without a custom tab renderer", async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness tasksEnabled />));
  expect(container.querySelectorAll("nav button")).toHaveLength(5);
  expect(native.props).not.toHaveProperty("tabBar");
  expect(native.props).not.toHaveProperty("tabBarStyle");
  expect(native.props).not.toHaveProperty("translucent");
  const state = native.props.navigationState as {
    routes: { key: string; role?: string }[];
  };
  expect(state.routes.at(-1)).toMatchObject({ key: "search", role: "search" });
  expect(
    container
      .querySelector('[aria-label="notes content"]')
      ?.getAttribute("data-inset"),
  ).toBe("113");
});
it("retains mounted screen state through tab switches and detail overlay, and gates Tasks", async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(container.querySelectorAll("nav button")).toHaveLength(4);
  expect(container.querySelector('[aria-label="tasks content"]')).toBeNull();
  const content = () =>
    container.querySelector(
      '[aria-label="notes content"]',
    ) as HTMLButtonElement;
  await act(async () => content().click());
  await act(async () =>
    (
      container.querySelector("nav button:last-child") as HTMLButtonElement
    ).click(),
  );
  await act(async () =>
    (
      container.querySelector("nav button:first-child") as HTMLButtonElement
    ).click(),
  );
  expect(content().textContent).toBe("1");
  await act(async () => root.render(<Harness hidden />));
  expect(container.querySelector("nav")).toBeNull();
  await act(async () =>
    (native.props.onIndexChange as (index: number) => void)(3),
  );
  expect((native.props.navigationState as { index: number }).index).toBe(0);
  await act(async () => root.render(<Harness />));
  expect(content().textContent).toBe("1");
  await act(async () =>
    (native.props.onIndexChange as (index: number) => void)(-1),
  );
  expect((native.props.navigationState as { index: number }).index).toBe(0);
});
