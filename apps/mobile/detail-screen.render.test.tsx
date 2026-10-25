import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  type Props = {
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
    }: Props) =>
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
    View: host("div"),
    Text: host("span"),
    Pressable: host("button"),
    Alert: { alert: () => undefined },
    Linking: { openURL: async () => undefined },
  };
});
import { NoteDetailScreen } from "./detail-screen";
import type { MobileSession } from "./session";
import { paletteFor } from "./theme";

vi.stubGlobal("React", React);
describe("research detail synthetic native render", () => {
  it("shows only a loading state before the owner-gated read and never invents report data", () => {
    const html = renderToStaticMarkup(
      React.createElement(NoteDetailScreen, {
        noteId: "11111111-1111-4111-8111-111111111111",
        session: {} as MobileSession,
        palette: paletteFor("light", "light"),
        onBack: () => undefined,
        onOpenSource: () => undefined,
      }),
    );
    expect(html).toContain("Loading note");
    expect(html).toContain('aria-label="Back"');
    expect(html).not.toContain("Saved complete report");
    expect(html).not.toContain("Open website");
    expect(html).not.toContain("Original user input — immutable");
  });
});
