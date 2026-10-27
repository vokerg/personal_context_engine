import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000099",
}));
vi.mock("./tab-bar", () => ({ NativeTabs: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  SafeAreaView: ({ children }: { children: React.ReactNode }) =>
    React.createElement("main", null, children),
}));
vi.mock("./native-auth", () => ({ createNativeSession: () => null }));
vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  type MockProps = {
    children?: React.ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean; disabled?: boolean };
  };
  const host =
    (tag: string) =>
    ({
      children,
      accessibilityRole,
      accessibilityLabel,
      accessibilityState,
    }: MockProps) =>
      element(
        tag,
        {
          role: accessibilityRole,
          "aria-label": accessibilityLabel,
          "aria-selected": accessibilityState?.selected,
          "aria-disabled": accessibilityState?.disabled,
        },
        children,
      );
  return {
    Appearance: { setColorScheme: vi.fn() },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Pressable: host("button"),
    Text: host("span"),
    View: host("div"),
    SafeAreaView: host("main"),
    KeyboardAvoidingView: host("div"),
    ScrollView: host("section"),
    StatusBar: () => null,
    useColorScheme: () => "dark",
  };
});

import App from "./App";
import { NotesScreen, SettingsScreen, UpcomingScreen } from "./screens";
import type { MobileSession } from "./session";
import { paletteFor } from "./theme";
import { StatusMessage } from "./ui";

// Vitest uses classic JSX for React Native TSX; Expo uses its native JSX transform.
vi.stubGlobal("React", React);

describe("native shell synthetic rendered accessibility", () => {
  const palette = paletteFor("dark", "dark");

  it("gates private notes and tabs when native auth is unconfigured", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("Native sign-in needs configuration");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("Refresh notes");
  });

  it("renders labelled, selected appearance options and sign out", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsScreen, {
        appearance: "dark",
        onAppearance: () => undefined,
        palette,
        onSignOut: () => undefined,
      }),
    );
    expect(html).toContain('role="header"');
    expect(html).toContain('aria-label="dark appearance"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-label="Sign out"');
  });

  it("renders a loading state before displaying any private notes", () => {
    const html = renderToStaticMarkup(
      React.createElement(NotesScreen, {
        session: {} as MobileSession,
        palette,
        onOpenNote: () => undefined,
      }),
    );
    expect(html).toContain("Loading notes");
    expect(html).not.toContain("Open note:");
  });

  it("renders a screen-reader alert and a visible retry on failure", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatusMessage, {
        palette,
        heading: "Unable to load notes",
        description: "Network unavailable",
        alert: true,
        retry: () => undefined,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Network unavailable");
    expect(html).toContain('aria-label="Retry"');
  });

  it("does not fabricate search results or claim capture is enabled", () => {
    for (const name of ["Search", "Capture"] as const) {
      const html = renderToStaticMarkup(
        React.createElement(UpcomingScreen, {
          name,
          explanation: "Feature not connected",
          palette,
        }),
      );
      expect(html).toContain(name + " is not available yet");
      expect(html).not.toContain("Saved");
    }
  });
});
