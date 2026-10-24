// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

it("switches theme on the sign-in screen and restores it on remount", async () => {
  await act(async () => {
    root.render(<App baseUrl="https://api.example.test" />);
  });
  const select = container.querySelector<HTMLSelectElement>("#theme-preference")!;
  expect(select.value).toBe("system");
  expect(window.localStorage.length).toBe(0);

  await act(async () => {
    select.value = "dark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(window.localStorage.getItem("pce-appearance")).toBe("dark");

  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(<App baseUrl="https://api.example.test" />);
  });
  const restored = container.querySelector<HTMLSelectElement>("#theme-preference")!;
  expect(restored.value).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");

  await act(async () => {
    restored.value = "light";
    restored.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.documentElement.dataset.theme).toBe("light");

  await act(async () => {
    restored.value = "system";
    restored.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.documentElement.dataset.theme).toBe("system");
  expect(window.localStorage.getItem("pce-appearance")).toBeNull();
});
