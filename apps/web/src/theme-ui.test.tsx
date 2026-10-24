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

it("changes and restores appearance from sign-in", async () => {
  await act(async () => {
    root.render(<App baseUrl="https://api.example.test" />);
  });
  const select = container.querySelector("select")!;
  expect(select.value).toBe("system");

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
  expect(container.querySelector("select")?.value).toBe("dark");
});
