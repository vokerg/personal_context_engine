import { describe, expect, it, vi } from "vitest";
import {
  MobileSession,
  parseNativeCallback,
  verifiedConfig,
  type MobileOAuthConfig,
  type OAuthPlatform,
} from "./session";

const config: MobileOAuthConfig = {
  apiOrigin: "https://pce.example",
  clientId: "ios-public",
  callback: "pce://oauth/callback",
  scopes: ["notes:read", "capture:write", "tags:write"],
};
const code = "c".repeat(64);
const access = "a".repeat(64);
const refresh = "r".repeat(64);
const rotated = "s".repeat(64);
const callback = (
  state = "state-01234567890123456789",
  iss = config.apiOrigin,
) =>
  "pce://oauth/callback?code=" +
  code +
  "&state=" +
  state +
  "&iss=" +
  encodeURIComponent(iss);
function fixture() {
  let saved: string | null = null;
  const platform: OAuthPlatform = {
    createAuthorization: async () => ({
      url: "https://pce.example/oauth/authorize?fixture=1",
      state: "state-01234567890123456789",
      codeVerifier: "v".repeat(64),
    }),
    openAuthorization: async () => callback(),
    readRefresh: async () => saved,
    writeRefresh: async (value) => {
      saved = value;
    },
    clearRefresh: async () => {
      saved = null;
    },
  };
  const calls: Array<{ path: string; fields: URLSearchParams }> = [];
  const request = vi.fn(
    async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const fields = new URLSearchParams(String(options?.body));
      calls.push({ path, fields });
      if (path === "/oauth/revoke") return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({
          access_token:
            calls.filter((x) => x.path === "/oauth/token").length === 1
              ? access
              : "b".repeat(64),
          refresh_token:
            calls.filter((x) => x.path === "/oauth/token").length === 1
              ? refresh
              : rotated,
          token_type: "Bearer",
          expires_in: 900,
          scope: "notes:read capture:write tags:write",
        }),
        { status: 200 },
      );
    },
  );
  return {
    platform,
    calls,
    request,
    session: new MobileSession(config, platform, request as typeof fetch),
    saved: () => saved,
  };
}

describe("iOS public-client callback", () => {
  it("accepts only exact registered handler, state, issuer and code", () => {
    expect(
      parseNativeCallback(callback(), config, "state-01234567890123456789"),
    ).toBe(code);
    for (const invalid of [
      callback("incorrect-state"),
      callback(undefined, "https://attacker.example"),
      callback() + "&code=other",
      callback() + "&refresh_token=bad",
      callback() + "#fragment",
      "pce://notes/callback?code=" + code,
      "pce://oauth/callback?error=access_denied&state=state-01234567890123456789&iss=https%3A%2F%2Fpce.example",
    ])
      expect(() =>
        parseNativeCallback(invalid, config, "state-01234567890123456789"),
      ).toThrow();
    expect(() =>
      verifiedConfig({ ...config, apiOrigin: "http://remote.example" }),
    ).toThrow();
    expect(() =>
      verifiedConfig({
        ...config,
        callback: "pce://notes/abc" as typeof config.callback,
      }),
    ).toThrow();
  });
  it("performs code exchange, secure rotation, and revocation without persisting access", async () => {
    const f = fixture();
    await f.session.signIn();
    expect(f.session.snapshot.phase).toBe("signed-in");
    expect(f.saved()).toBe(refresh);
    expect(await f.session.getAccessToken()).toBe(access);
    expect(f.calls[0]?.fields.get("grant_type")).toBe("authorization_code");
    expect(f.calls[0]?.fields.get("code_verifier")).toBe("v".repeat(64));
    expect(f.calls[0]?.fields.get("resource")).toBe(config.apiOrigin + "/mcp");
    const [one, two] = await Promise.all([
      f.session.forceRefresh(),
      f.session.getAccessToken(true),
    ]);
    expect(one).toBe("b".repeat(64));
    expect(two).toBe(one);
    expect(f.calls.filter((x) => x.path === "/oauth/token")).toHaveLength(2);
    expect(f.saved()).toBe(rotated);
    await f.session.signOut();
    expect(f.saved()).toBeNull();
    expect(f.session.snapshot.phase).toBe("signed-out");
    expect(f.calls.at(-1)?.path).toBe("/oauth/revoke");
    expect(f.calls.at(-1)?.fields.get("token")).toBe(rotated);
  });
  it("restores with refresh only and clears an invalid/replayed grant", async () => {
    const f = fixture();
    await f.session.signIn();
    const reopened = new MobileSession(
      config,
      f.platform,
      f.request as typeof fetch,
    );
    await reopened.restore();
    expect(reopened.snapshot.phase).toBe("signed-in");
    expect(f.saved()).toBe(rotated);
    const denied = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    );
    const invalid = new MobileSession(
      config,
      f.platform,
      denied as typeof fetch,
    );
    await invalid.restore();
    expect(invalid.snapshot.phase).toBe("signed-out");
    expect(f.saved()).toBeNull();
  });
  it("preserves stored refresh after network failures for an explicit retry", async () => {
    const f = fixture();
    await f.session.signIn();
    const offline = new MobileSession(
      config,
      f.platform,
      vi.fn(async () => {
        throw new Error("private network info");
      }) as typeof fetch,
    );
    await offline.restore();
    expect(offline.snapshot.phase).toBe("signed-out");
    expect(offline.snapshot.notice).not.toContain("private network info");
    expect(f.saved()).toBe(refresh);
  });
});
