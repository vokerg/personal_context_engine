// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App.js";

let root: Root;
let container: HTMLDivElement;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
async function render() {
  await act(async () => {
    root.render(<App baseUrl="https://web.example" />);
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("PROD", true);
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_PCE_SESSION_AUTH", "false");
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("keeps password authentication in production with missing flags and delayed discovery", async () => {
  let resolveConfig!: (response: Response) => void;
  const fetcher = vi.fn((target: URL | string) =>
    String(target).endsWith("/auth/config")
      ? new Promise<Response>((resolve) => {
          resolveConfig = resolve;
        })
      : Promise.resolve(json({}, 401)),
  );
  vi.stubGlobal("fetch", fetcher);
  await render();
  expect(container.textContent).toContain("Checking sign-in service");
  expect(container.textContent).not.toContain("Development access token");
  await act(async () => {
    resolveConfig(json({ mode: "single-user" }));
  });
  expect(container.textContent).toContain("Username");
  expect(container.textContent).toContain("Password");
  expect(
    fetcher.mock.calls.every(([url]) => !String(url).includes("dev-session")),
  ).toBe(true);
});

it.each(["offline", "invalid", "dev-single-user"])(
  "fails closed on %s configuration and can retry",
  async (failure) => {
    let retry = false;
    const fetcher = vi.fn(async (target: URL | string) => {
      if (!String(target).endsWith("/auth/config")) return json({}, 401);
      if (retry) return json({ mode: "single-user" });
      if (failure === "offline") throw new Error("synthetic offline");
      return json({ mode: failure });
    });
    vi.stubGlobal("fetch", fetcher);
    await render();
    expect(container.textContent).toContain("Sign-in service unavailable");
    expect(container.textContent).not.toContain("Development access token");
    expect(container.querySelector("form")).toBeNull();
    retry = true;
    await click("Retry sign-in service");
    expect(container.textContent).toContain("Username");
    expect(
      fetcher.mock.calls.every(([url]) => !String(url).includes("dev-session")),
    ).toBe(true);
  },
);

it("bootstraps only an explicitly configured development session after a 401", async () => {
  vi.stubEnv("PROD", false);
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_PCE_SESSION_AUTH", "true");
  const fetcher = vi.fn(async (target: URL | string, init?: RequestInit) => {
    const url = String(target);
    if (url.endsWith("/auth/config")) return json({ mode: "dev-single-user" });
    if (url.endsWith("/auth/session")) return json({}, 401);
    if (url.endsWith("/auth/dev-session")) {
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("include");
      return json({ authenticated: true });
    }
    if (url.endsWith("/api/v1/tags"))
      return json({ tags: [], truncated: false });
    return json({ notes: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  await render();
  expect(container.textContent).toContain("Clear session");
  expect(
    fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/auth/dev-session"),
    ),
  ).toHaveLength(1);
});

it("does not bootstrap a new development session on an API failure", async () => {
  vi.stubEnv("PROD", false);
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_PCE_SESSION_AUTH", "true");
  const fetcher = vi.fn(async (target: URL | string) =>
    String(target).endsWith("/auth/config")
      ? json({ mode: "dev-single-user" })
      : json({}, 503),
  );
  vi.stubGlobal("fetch", fetcher);
  await render();
  expect(container.textContent).toContain("Sign-in service unavailable");
  expect(
    fetcher.mock.calls.every(([url]) => !String(url).includes("dev-session")),
  ).toBe(true);
});

it.each(["http", "network"])(
  "reports %s logout failure and permits retry before clearing the session",
  async (failure) => {
    let logoutFails = true;
    document.cookie = "pce_csrf=synthetic-csrf; Path=/";
    const fetcher = vi.fn(async (target: URL | string, init?: RequestInit) => {
      const url = String(target);
      if (url.endsWith("/auth/config")) return json({ mode: "single-user" });
      if (url.endsWith("/auth/session")) return json({ authenticated: true });
      if (url.endsWith("/auth/logout")) {
        expect(init?.credentials).toBe("include");
        expect(init?.headers).toEqual({ "X-PCE-CSRF": "synthetic-csrf" });
        if (logoutFails && failure === "network")
          throw new Error("synthetic offline");
        return json({}, logoutFails ? 503 : 200);
      }
      if (url.endsWith("/api/v1/tags"))
        return json({ tags: [], truncated: false });
      return json({ notes: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    await render();
    await click("Clear session");
    expect(container.textContent).toContain("Your session may still be active");
    expect(container.textContent).toContain("Clear session");
    logoutFails = false;
    await click("Clear session");
    expect(container.textContent).not.toContain("Clear session");
    expect(container.textContent).toContain("Username");
    document.cookie = "pce_csrf=; Max-Age=0; Path=/";
  },
);
