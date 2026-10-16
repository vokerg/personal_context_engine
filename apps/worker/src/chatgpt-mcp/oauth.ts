import { createPublicKey, verify } from "node:crypto";

export interface OAuthConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  ownerSub: string;
  resourceUrl: string;
}
interface Claims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  scope?: unknown;
  scp?: unknown;
}
const b64json = (part: string): unknown =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

export function oauthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OAuthConfig {
  const issuer = env.PCE_MCP_OAUTH_ISSUER;
  const audience = env.PCE_MCP_OAUTH_AUDIENCE;
  const jwksUrl = env.PCE_MCP_OAUTH_JWKS_URL;
  const ownerSub = env.PCE_MCP_OWNER_SUB;
  const resourceUrl = env.PCE_MCP_RESOURCE_URL;
  try {
    if (
      !issuer ||
      !audience ||
      !jwksUrl ||
      !ownerSub ||
      !resourceUrl ||
      ![issuer, jwksUrl, resourceUrl].every((url) => {
        const parsed = new URL(url);
        return (
          parsed.protocol === "https:" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.hash &&
          !parsed.search
        );
      }) ||
      new URL(resourceUrl).pathname !== "/mcp" ||
      !/^[^\s]{1,256}$/.test(ownerSub)
    )
      throw new Error("invalid");
  } catch {
    throw new Error("Missing or invalid MCP OAuth configuration");
  }
  return { issuer, audience, jwksUrl, ownerSub, resourceUrl };
}

/** Resource-server checks only. OAuth authorization flow is managed by an external IdP. */
export function makeOAuthVerifier(
  config: OAuthConfig,
  http: typeof fetch = fetch,
) {
  let keys: { keys?: Array<Record<string, unknown>> } | undefined;
  let until = 0;
  return async (authorization: string | undefined): Promise<boolean> => {
    if (!authorization?.startsWith("Bearer ")) return false;
    const token = authorization.slice(7);
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      return false;
    try {
      const header = b64json(parts[0]!) as {
        alg?: unknown;
        kid?: unknown;
        typ?: unknown;
      };
      const claims = b64json(parts[1]!) as Claims;
      const now = Math.floor(Date.now() / 1000);
      if (
        header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        claims.iss !== config.issuer ||
        claims.sub !== config.ownerSub ||
        typeof claims.exp !== "number" ||
        claims.exp <= now ||
        (claims.nbf !== undefined &&
          (typeof claims.nbf !== "number" || claims.nbf > now)) ||
        !(
          claims.aud === config.audience ||
          (Array.isArray(claims.aud) && claims.aud.includes(config.audience))
        ) ||
        !(
          (typeof claims.scope === "string" &&
            claims.scope.split(/\s+/).includes("pce.capture")) ||
          (Array.isArray(claims.scp) && claims.scp.includes("pce.capture"))
        )
      )
        return false;
      if (!keys || until < Date.now()) {
        const response = await http(config.jwksUrl, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return false;
        const body: unknown = await response.json();
        if (
          !body ||
          typeof body !== "object" ||
          !Array.isArray((body as { keys?: unknown }).keys)
        )
          return false;
        keys = body as { keys: Array<Record<string, unknown>> };
        until = Date.now() + 10 * 60_000;
      }
      const key = keys.keys?.find(
        (candidate) =>
          candidate.kid === header.kid &&
          candidate.kty === "RSA" &&
          (candidate.use === undefined || candidate.use === "sig") &&
          (candidate.alg === undefined || candidate.alg === "RS256"),
      );
      if (!key) return false;
      const publicKey = createPublicKey({
        key: key as JsonWebKey,
        format: "jwk",
      });
      return verify(
        "RSA-SHA256",
        Buffer.from(parts[0] + "." + parts[1]),
        publicKey,
        Buffer.from(parts[2]!, "base64url"),
      );
    } catch {
      return false;
    }
  };
}
