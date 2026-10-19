import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createRs256TokenVerifier } from "./auth.js";
import { loadApiConfig } from "./config.js";

const identity = {
  issuer: "test-issuer",
  audience: "test-api",
  keyId: "test-key-1",
};
const primary = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const foreign = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const now = Math.floor(Date.now() / 1000);
const rsConfig = { ...identity, publicKeyPem: primary.publicKey };

function token(
  claimOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
  privateKey = primary.privateKey,
): string {
  const header = Buffer.from(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT",
      kid: identity.keyId,
      ...headerOverrides,
    }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: identity.issuer,
      aud: identity.audience,
      sub: "owner-a",
      scope: "notes:read",
      iat: now - 10,
      exp: now + 600,
      ...claimOverrides,
    }),
  ).toString("base64url");
  const signed = header + "." + claims;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signed, "ascii"),
    privateKey,
  );
  return signed + "." + signature.toString("base64url");
}

describe("pinned RS256 issuer verification (#44)", () => {
  it("accepts a valid scoped RS256 token", async () => {
    const verify = createRs256TokenVerifier(rsConfig, () => now);
    expect(await verify(token())).toEqual({
      subject: "owner-a",
      scopes: ["notes:read"],
    });
  });

  it("rejects algorithm confusion and untrusted key headers", async () => {
    const verify = createRs256TokenVerifier(rsConfig, () => now);
    const valid = token();
    const invalid = [
      token({}, { alg: "HS256" }),
      token({}, { alg: "none" }),
      token({}, { typ: "JOSE" }),
      token({}, { kid: "other-key" }),
      token({}, { kid: undefined }),
      token({}, { crit: ["exp"] }),
      token({}, { jku: "https://evil.example/keys" }),
      token({}, { jwk: { kty: "RSA" } }),
      token({}, { x5u: "https://evil.example/cert" }),
      token({}, { x5c: ["anything"] }),
      token({}, {}, foreign.privateKey),
      valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A"),
      valid + ".trailing",
      "not-a-jwt",
    ];
    for (const candidate of invalid) {
      expect(await verify(candidate)).toBeNull();
    }
  });

  it("rejects wrong identity, timing and malformed scopes", async () => {
    const verify = createRs256TokenVerifier(rsConfig, () => now);
    for (const claims of [
      { iss: "foreign-issuer" },
      { aud: "another-api" },
      { aud: ["test-api"] },
      { sub: "bad\nsubject" },
      { sub: "" },
      { exp: now },
      { exp: now + 7200 },
      { iat: now + 61 },
      { nbf: now + 1 },
      { scope: ["notes:read"] },
      { scope: "notes:read invalid/scope" },
    ]) {
      expect(await verify(token(claims))).toBeNull();
    }
  });

  it("validates pinned RSA config and rejects mixed verifier secrets", () => {
    const valid = loadApiConfig({
      NODE_ENV: "production",
      API_AUTH_ISSUER: identity.issuer,
      API_AUTH_AUDIENCE: identity.audience,
      API_AUTH_RS256_PUBLIC_KEY_PEM: primary.publicKey,
      API_AUTH_RS256_KEY_ID: identity.keyId,
    });
    expect(valid.auth).toBeNull();
    expect(valid.rs256Auth).toEqual(rsConfig);
    for (const extra of [
      { API_AUTH_HS256_SECRET: "a".repeat(40) },
      { API_AUTH_RS256_KEY_ID: "" },
      { API_AUTH_RS256_KEY_ID: "bad/key" },
      { API_AUTH_RS256_PUBLIC_KEY_PEM: "not-a-key" },
      { API_AUTH_RS256_PUBLIC_KEY_PEM: primary.privateKey },
    ]) {
      expect(() =>
        loadApiConfig({
          NODE_ENV: "production",
          API_AUTH_ISSUER: identity.issuer,
          API_AUTH_AUDIENCE: identity.audience,
          API_AUTH_RS256_PUBLIC_KEY_PEM: primary.publicKey,
          API_AUTH_RS256_KEY_ID: identity.keyId,
          ...extra,
        }),
      ).toThrow();
    }
    expect(() =>
      loadApiConfig({
        API_AUTH_ISSUER: identity.issuer,
        API_AUTH_AUDIENCE: identity.audience,
        API_AUTH_RS256_PUBLIC_KEY_PEM: primary.publicKey,
      }),
    ).toThrow();
  });

  it("enforces scoped HTTP access and owner isolation", async () => {
    const config = loadApiConfig({
      API_AUTH_ISSUER: identity.issuer,
      API_AUTH_AUDIENCE: identity.audience,
      API_AUTH_RS256_PUBLIC_KEY_PEM: primary.publicKey,
      API_AUTH_RS256_KEY_ID: identity.keyId,
    });
    const sample = {
      id: "01K00000000000000000000001",
      title: "Synthetic",
      summary: "Synthetic summary",
      capturedAt: "2026-10-16T10:00:00+02:00",
    };
    const app = createApp({
      config,
      dependencies: {
        notes: {
          listByOwner: async (subject) =>
            subject === "owner-a" ? [sample] : [],
          getByOwner: async () => null,
        },
      },
    });
    try {
      const request = (jwt: string, url = "/api/v1/notes") =>
        app.inject({ url, headers: { authorization: "Bearer " + jwt } });
      const allowed = await request(token());
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().notes).toHaveLength(1);
      const noScope = await request(token({ scope: "capture:write" }));
      expect(noScope.statusCode).toBe(403);
      const forged = await request(token({ sub: "owner-b" }));
      expect(forged.statusCode).toBe(200);
      expect(forged.json().notes).toEqual([]);
      const otherOwner = await request(
        token(),
        "/api/v1/notes/01K00000000000000000000002",
      );
      expect(otherOwner.statusCode).toBe(404);
      const bad = await request(token({ aud: "foreign" }));
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toEqual({ error: { code: "UNAUTHORIZED" } });
      expect(bad.body).not.toContain("Synthetic");
    } finally {
      await app.close();
    }
  });
});
