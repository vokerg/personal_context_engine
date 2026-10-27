// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  available: true,
  changed: vi.fn<(enabled: boolean) => void>(),
  remove: vi.fn(),
}));
vi.mock("expo-glass-effect", () => ({
  GlassView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-glass": true }, children),
  isLiquidGlassAvailable: () => native.available,
  isGlassEffectAPIAvailable: () => native.available,
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  AccessibilityInfo: {
    isReduceTransparencyEnabled: async () => false,
    addEventListener: (
      _event: string,
      listener: (enabled: boolean) => void,
    ) => {
      native.changed.mockImplementation(listener);
      return { remove: native.remove };
    },
  },
  View: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  Text: ({ children }: { children: React.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({
    children,
    accessibilityLabel,
    accessibilityState,
    onPress,
  }: {
    children: React.ReactNode;
    accessibilityLabel: string;
    accessibilityState: { selected: boolean };
    onPress: () => void;
  }) =>
    React.createElement(
      "button",
      {
        "aria-label": accessibilityLabel,
        "aria-selected": accessibilityState.selected,
        onClick: onPress,
      },
      children,
    ),
}));
import { TabBar } from "./tab-bar";
import { paletteFor } from "./theme";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root.unmount());
  expect(native.remove).toHaveBeenCalledOnce();
  native.available = true;
  vi.clearAllMocks();
});

describe("native menu accessibility and compatibility", () => {
  async function mount(tasksEnabled = false) {
    root = createRoot(container);
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <TabBar
          active="notes"
          tasksEnabled={tasksEnabled}
          palette={paletteFor("light", "light")}
          onSelect={onSelect}
          onHeight={() => undefined}
        />,
      );
    });
    return onSelect;
  }

  it("follows live Reduce Transparency changes and removes its subscription", async () => {
    await mount();
    expect(container.querySelector("[data-glass]")).not.toBeNull();
    await act(async () => native.changed(true));
    expect(container.querySelector("[data-glass]")).toBeNull();
    await act(async () => native.changed(false));
    expect(container.querySelector("[data-glass]")).not.toBeNull();
  });

  it("keeps unsupported builds opaque and preserves labelled tab selection", async () => {
    native.available = false;
    const onSelect = await mount();
    expect(container.querySelector("[data-glass]")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(4);
    expect(
      container
        .querySelector('[aria-label="Notes"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Search"]')!
        .click();
    });
    expect(onSelect).toHaveBeenCalledWith("search");
  });
  it("adds the separately enabled Tasks tab without replacing existing navigation", async () => {
    const onSelect = await mount(true);
    expect(container.querySelectorAll("[data-glass] button")).toHaveLength(5);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Tasks"]')!
        .click(),
    );
    expect(onSelect).toHaveBeenCalledWith("tasks");
  });
});
