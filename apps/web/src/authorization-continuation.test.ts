import { expect, it } from "vitest";
import { authorizationContinuation } from "./authorization-continuation";
it("resumes the complete authorization on a fixed API path, retaining PKCE and state", () => {
  const parameters = new URLSearchParams({
    client_id: "ios",
    redirect_uri: "pce://oauth/callback",
    state: "synthetic-state",
    code_challenge: "synthetic-challenge",
    code_challenge_method: "S256",
    scope: "notes:read tasks:read",
    resource: "https://api.example/mcp",
  });
  const login = new URL("https://web.example/");
  login.searchParams.set("authorize", parameters.toString());
  const target = new URL(
    authorizationContinuation(login.href, "https://api.example")!,
  );
  expect(target.origin + target.pathname).toBe(
    "https://api.example/oauth/authorize",
  );
  expect([...target.searchParams]).toEqual([...parameters]);
});
it("ignores absent/oversized requests and never treats supplied text as a redirect URL", () => {
  expect(
    authorizationContinuation("https://web.example", "https://api.example"),
  ).toBeNull();
  expect(
    authorizationContinuation(
      "https://web.example/?authorize=" + "x".repeat(4097),
      "https://api.example",
    ),
  ).toBeNull();
  expect(
    authorizationContinuation(
      "https://web.example/?authorize=https://evil.example",
      "https://api.example",
    ),
  ).toMatch(/^https:\/\/api.example\/oauth\/authorize\?/);
});
