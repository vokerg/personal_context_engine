import { describe, expect, it } from "vitest";
import { paletteFor } from "./theme.js";

// WCAG 2.1 relative luminance; synthetic contrast checks, not device QA.
function luminance(hex: string): number {
  const values = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}
function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("iOS appearance tokens", () => {
  it("follows system appearance unless explicitly overridden", () => {
    expect(paletteFor("system", "dark").dark).toBe(true);
    expect(paletteFor("system", "light").dark).toBe(false);
    expect(paletteFor("system", null).dark).toBe(false);
    expect(paletteFor("light", "dark").dark).toBe(false);
    expect(paletteFor("dark", "light").dark).toBe(true);
  });

  it("maintains readable text, secondary text and button labels", () => {
    for (const mode of ["light", "dark"] as const) {
      const colors = paletteFor(mode, null);
      expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.secondary, colors.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.onPrimary, colors.primary)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
