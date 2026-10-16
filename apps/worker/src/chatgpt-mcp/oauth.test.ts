import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeOAuthVerifier, oauthConfigFromEnv, type OAuthConfig } from "./oauth.js";

const oauth: OAuthConfig = {
  issuer: "https://login.synthetic.test",
  jwksUrl: "https://login.synthetic.test/jwks",
  audience: "https://capture.synthetic.test/mcp",
  ownerSub: "synthetic-owner",
  resourceUrl: "https://capture.synthetic.test/mcp",
};
function prepare() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    keys: [{ ...jwk, use: "sig", alg: "RS256", kid: "key-1" }],
  }), { status: 200 });
  const sign = (claims: Record<string, unknown>, algorithm = "RS256") => {
    const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: "key-1" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signingInput = header + "." + payload;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    return "Bearer " + signingInput + "." + signer.sign(privateKey).toString("base64url");
  };
  const claims = {
    iss: oauth.issuer,
    aud: oauth.audience,
    sub: oauth.ownerSub,
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "pce.capture",
  };
  return { sign, claims, fetcher };
}
describe("PCE OAuth resource validation", () => {
  it("accepts a correctly scoped, signed owner access token", async () => {
    const { sign, claims, fetcher } = prepare();
    expect(await makeOAuthVerifier(oauth, fetcher)(sign(claims))).toBe(true);
  });
  it("rejects missing, expired, wrong owner, wrong audience and insufficient scope", async () => {
    const { sign, claims, fetcher } = prepare();
    const verify = makeOAuthVerifier(oauth, fetcher);
    expect(await verify(undefined)).toBe(false);
    for (const changed of [
      { ...claims, sub: "attacker" },
      { ...claims, aud: "https://different.synthetic.test" },
      { ...claims, scope: "pce.read" },
      { ...claims, exp: Math.floor(Date.now() / 1000) - 1 },
      { ...claims, nbf: Math.floor(Date.now() / 1000) + 3600 },
    ]) expect(await verify(sign(changed))).toBe(false);
    const forged = sign(claims).replace(/.$/, "x");
    expect(await verify(forged)).toBe(false);
    expect(await verify(sign(claims, "none"))).toBe(false);
  });
  it("fails closed on incomplete OAuth configuration", () => {
    expect(() => oauthConfigFromEnv({})).toThrow();
    expect(() => oauthConfigFromEnv({
      PCE_MCP_OAUTH_ISSUER: "http://unsafe.synthetic",
      PCE_MCP_OAUTH_AUDIENCE: oauth.audience,
      PCE_MCP_OAUTH_JWKS_URL: oauth.jwksUrl,
      PCE_MCP_OWNER_SUB: oauth.ownerSub,
      PCE_MCP_RESOURCE_URL: oauth.resourceUrl,
    })).toThrow();
  });
});
