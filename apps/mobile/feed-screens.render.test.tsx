import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@react-native-community/datetimepicker", () => ({
  default: () => null,
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
}));
vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  type HostProps = {
    children?: React.ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
    placeholder?: string;
  };
  const host =
    (tag: string) =>
    ({
      children,
      accessibilityRole,
      accessibilityLabel,
      accessibilityState,
      placeholder,
    }: HostProps) =>
      element(
        tag,
        {
          role: accessibilityRole,
          "aria-label": accessibilityLabel,
          "aria-selected": accessibilityState?.selected,
          placeholder,
        },
        children,
      );
  return {
    View: host("div"),
    Text: host("span"),
    Pressable: host("button"),
    TextInput: host("input"),
    RefreshControl: () => null,
    Keyboard: { dismiss: () => undefined },
    FlatList: ({
      data,
      ListEmptyComponent,
      ListFooterComponent,
    }: {
      data: unknown[];
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    }) =>
      element(
        "section",
        { "data-virtualized": "FlatList", "data-count": data.length },
        data.length ? null : ListEmptyComponent,
        ListFooterComponent,
      ),
  };
});
import { SearchScreen, TimelineScreen } from "./feed-screens";
import type { MobileSession } from "./session";
import { paletteFor } from "./theme";
vi.stubGlobal("React", React);
const palette = paletteFor("light", "light");
const session = {} as MobileSession;

describe("native screen synthetic rendering", () => {
  it("uses a virtualized timeline with initial loading and accessible filter disclosure", () => {
    const html = renderToStaticMarkup(
      React.createElement(TimelineScreen, {
        session,
        palette,
        onOpenNote: () => undefined,
      }),
    );
    expect(html).toContain('data-virtualized="FlatList"');
    expect(html).toContain("Loading notes");
    expect(html).toContain('aria-label="Filters"');
    expect(html).not.toContain("Saved");
  });
  it("has a labelled keyboard search input and an honest pre-query state", () => {
    const html = renderToStaticMarkup(
      React.createElement(SearchScreen, {
        session,
        palette,
        onOpenNote: () => undefined,
      }),
    );
    expect(html).toContain('aria-label="Search your notes"');
    expect(html).toContain("Enter a search");
    expect(html).toContain('data-virtualized="FlatList"');
    expect(html).not.toContain("Hybrid: lexical and semantic retrieval");
  });
});
