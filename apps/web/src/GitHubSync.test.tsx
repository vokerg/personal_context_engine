// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubSync as WebSync } from "./GitHubSync.js";
import { GitHubSync as NativeSync } from "../../mobile/github-sync";
import { paletteFor } from "../../mobile/theme";
import type { MobileSession } from "../../mobile/session";
vi.mock("react-native", () => ({
  View: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: React.ReactNode;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
let root: Root, container: HTMLDivElement;
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.cookie = "pce_csrf=synthetic-csrf";
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
for (const surface of ["web", "ios"] as const) {
  it(`${surface} distinguishes fetching from processing and prevents duplicate submissions`, async () => {
    let release: (() => void) | undefined;
    let writes = 0;
    const request = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (surface === "web") expect(init?.credentials).toBe("include");
        else
          expect(init?.headers).toMatchObject({
            Authorization: "Bearer native-token",
          });
        if (init?.method === "POST") {
          writes++;
          if (surface === "web")
            expect(init.headers).toMatchObject({
              "X-PCE-CSRF": "synthetic-csrf",
            });
          expect(JSON.parse(String(init.body))).toEqual({});
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return new Response(
            JSON.stringify({
              examined: 3,
              staged: 1,
              alreadyStaged: 2,
              failed: 0,
              hasMore: true,
            }),
          );
        }
        return new Response(
          JSON.stringify({
            enabled: true,
            reason: null,
            lastSuccessfulScan: null,
            hasMore: false,
            pending: 1,
            processed: 0,
            invalid: 0,
          }),
        );
      },
    );
    vi.stubGlobal("fetch", request);
    const session = {
      config: { apiOrigin: "https://api.example" },
      getAccessToken: async () => "native-token",
    } as unknown as MobileSession;
    await act(async () =>
      root.render(
        surface === "web" ? (
          <WebSync
            baseUrl="https://api.example"
            token="cookie"
            useSessionCookie
          />
        ) : (
          <NativeSync
            session={session}
            palette={paletteFor("light", "light")}
          />
        ),
      ),
    );
    await flush();
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.click();
      button.click();
    });
    await flush();
    expect(writes).toBe(1);
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("Fetching from GitHub");
    await act(async () => release!());
    await flush();
    expect(container.textContent).toContain(
      "1 staged, 2 already staged, 0 failed",
    );
    expect(container.textContent).toContain("Another batch remains");
    expect(container.textContent).toContain("Processing: 1 pending");
    expect(container.textContent).not.toContain("imported");
  });
  it(`${surface} disables fetching with the backend explanation`, async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            enabled: false,
            reason: "GitHub fetching is disabled on this API.",
            lastSuccessfulScan: null,
            hasMore: false,
            pending: 2,
            processed: 0,
            invalid: 0,
          }),
        ),
    );
    const session = {
      config: { apiOrigin: "https://api.example" },
      getAccessToken: async () => "native-token",
    } as unknown as MobileSession;
    await act(async () =>
      root.render(
        surface === "web" ? (
          <WebSync
            baseUrl="https://api.example"
            token="cookie"
            useSessionCookie
          />
        ) : (
          <NativeSync
            session={session}
            palette={paletteFor("light", "light")}
          />
        ),
      ),
    );
    await flush();
    expect(container.querySelector("button")!.disabled).toBe(true);
    expect(container.textContent).toContain("GitHub fetching is disabled");
  });
}
