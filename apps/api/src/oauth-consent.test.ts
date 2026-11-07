import Fastify from "fastify";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { PrismaClient } from "@pce/db";
import { registerOAuth } from "./oauth.js";
import type { SessionAuth } from "./session-auth.js";

const params = new URLSearchParams({
  response_type: "code",
  client_id: "synthetic-ios",
  redirect_uri: "pce://oauth/callback",
  resource: "https://api.example/mcp",
  scope: "notes:read",
  state: "s".repeat(32),
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
});
function setup(signedIn: boolean) {
  const app = Fastify();
  registerOAuth(
    app,
    {} as PrismaClient,
    {
      config: {
        issuer: "https://api.example",
        audience: "https://api.example/mcp",
        origin: "https://web.example",
      },
      browserSession: async () =>
        signedIn
          ? {
              csrfHash: createHash("sha256")
                .update("synthetic-csrf")
                .digest("hex"),
            }
          : null,
    } as unknown as SessionAuth,
    [
      {
        clientId: "synthetic-ios",
        redirectUris: ["pce://oauth/callback"],
        scopes: ["notes:read"],
      },
    ],
  );
  return app;
}
it("retains the validated authorization request through the password-login redirect", async () => {
  const app = setup(false);
  try {
    const reply = await app.inject("/oauth/authorize?" + params);
    expect(reply.statusCode).toBe(302);
    const target = new URL(reply.headers.location as string);
    expect(target.origin).toBe("https://web.example");
    expect(target.searchParams.get("authorize")).toBe(params.toString());
  } finally {
    await app.close();
  }
});
it("renders readable mobile consent controls while preserving CSRF and callback CSP", async () => {
  const app = setup(true);
  try {
    const reply = await app.inject({
      url: "/oauth/authorize?" + params,
      headers: { cookie: "pce_csrf=synthetic-csrf" },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain('name="viewport"');
    expect(reply.body).toContain("min-height:52px");
    expect(reply.body).toContain('name="decision" value="allow"');
    expect(reply.body).toContain('name="decision" value="deny"');
    expect(reply.body).toContain('name="csrf" value="synthetic-csrf"');
    expect(reply.headers["content-security-policy"]).toContain(
      "form-action 'self' pce:",
    );
    expect(
      (
        await app.inject({
          url: "/oauth/authorize?" + params,
          headers: { cookie: "pce_csrf=wrong" },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
it("rejects a changed native callback before redirecting to login", async () => {
  const app = setup(false);
  try {
    const unsafe = new URLSearchParams(params);
    unsafe.set("redirect_uri", "https://evil.example");
    const reply = await app.inject("/oauth/authorize?" + unsafe);
    expect(reply.statusCode).toBe(400);
    expect(reply.headers.location).toBeUndefined();
  } finally {
    await app.close();
  }
});
