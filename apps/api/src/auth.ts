import { createHmac, timingSafeEqual } from "node:crypto";
import type { ApiAuthConfig } from "./config.js";

/** Identity comes only from an authenticated token, never from a route or query. */
export interface AuthenticatedPrincipal {
  subject: string;
  scopes: readonly string[];
}

export type TokenVerifier = (
  bearerToken: string,
) => Promise<AuthenticatedPrincipal | null>;

const base64Url = /^[A-Za-z0-9_-]+$/;
const subjectPattern = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;

function decodePart(value: string): unknown {
  if (!base64Url.test(value)) return null;
  const raw = Buffer.from(value, "base64url");
  if (raw.toString("base64url") !== value || raw.byteLength > 4096) return null;
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict, single-algorithm JWT profile; replaceable with an OIDC/JWKS verifier. */
export function createHmacTokenVerifier(
  config: ApiAuthConfig,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): TokenVerifier {
  const key = Buffer.from(config.secret, "utf8");
  return async (token) => {
    if (token.length > 4096) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedMac] = parts;
    if (!encodedHeader || !encodedClaims || !encodedMac) return null;
    const header = decodePart(encodedHeader);
    const claims = decodePart(encodedClaims);
    if (!record(header) || !record(claims)) return null;
    if (
      header.alg !== "HS256" ||
      header.typ !== "JWT" ||
      header.crit !== undefined
    )
      return null;
    if (!base64Url.test(encodedMac)) return null;
    const mac = Buffer.from(encodedMac, "base64url");
    if (mac.toString("base64url") !== encodedMac || mac.length !== 32)
      return null;
    const expected = createHmac("sha256", key)
      .update(encodedHeader + "." + encodedClaims)
      .digest();
    if (!timingSafeEqual(mac, expected)) return null;

    const now = nowSeconds();
    if (
      claims.iss !== config.issuer ||
      claims.aud !== config.audience ||
      typeof claims.sub !== "string" ||
      !subjectPattern.test(claims.sub) ||
      typeof claims.scope !== "string" ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      (claims.nbf !== undefined && !Number.isSafeInteger(claims.nbf))
    )
      return null;

    const issued = claims.iat as number;
    const expires = claims.exp as number;
    if (
      issued > now + 60 ||
      expires <= now ||
      expires <= issued ||
      expires - issued > 3600 ||
      (claims.nbf !== undefined && (claims.nbf as number) > now)
    )
      return null;
    const scopes = claims.scope.split(" ").filter(Boolean);
    return { subject: claims.sub, scopes };
  };
}
