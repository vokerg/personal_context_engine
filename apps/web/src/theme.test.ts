// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  readThemePreference,
  saveThemePreference,
} from "./theme.js";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web appearance preference", () => {
  it("defaults to system mode without storing personal data", () => {
    expect(readThemePreference()).toBe("system");
    applyThemePreference(readThemePreference());
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(window.localStorage.length).toBe(0);
  });

  it("persists light/dark choices and restores automatic system mode", () => {
    saveThemePreference("dark");
    expect(readThemePreference()).toBe("dark");
    applyThemePreference(readThemePreference());
    expect(document.documentElement.dataset.theme).toBe("dark");
    saveThemePreference("light");
    expect(readThemePreference()).toBe("light");
    saveThemePreference("system");
    expect(readThemePreference()).toBe("system");
    expect(window.localStorage.length).toBe(0);
  });

  it("ignores unexpected storage values without trusting them as UI state", () => {
    window.localStorage.setItem("pce-appearance", "untrusted");
    expect(readThemePreference()).toBe("system");
  });

  it("still switches theme when localStorage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    expect(() => saveThemePreference("dark")).not.toThrow();
    applyThemePreference("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
