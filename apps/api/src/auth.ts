import {
  constants,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import type { ApiAuthConfig, ApiRs256AuthConfig } from "./config.js";

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

/** Validate even injected verifier results before they reach any DB adapter. */
export function isAuthenticatedPrincipal(
  value: unknown,
): value is AuthenticatedPrincipal {
  if (!record(value)) return false;
  return (
    typeof value.subject === "string" &&
    subjectPattern.test(value.subject) &&
    Array.isArray(value.scopes) &&
    value.scopes.every(
      (scope: unknown) =>
        typeof scope === "string" && /^[a-z][a-z0-9:-]{0,63}$/.test(scope),
    )
  );
}

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

    return validateClaims(claims, config, nowSeconds());
  };
}

/** Reused claim profile for local HS256 and pinned issuer RS256 credentials. */
function validateClaims(
  claims: Record<string, unknown>,
  config: { issuer: string; audience: string },
  now: number,
): AuthenticatedPrincipal | null {
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
  const principal = {
    subject: claims.sub,
    scopes: claims.scope.split(" ").filter(Boolean),
  };
  return isAuthenticatedPrincipal(principal) ? principal : null;
}

/** Verify only a configured RSA public key; never fetch key URLs from tokens. */
export function createRs256TokenVerifier(
  config: ApiRs256AuthConfig,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): TokenVerifier {
  if (!config.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")) {
    throw new Error("RS256 verifier requires an SPKI public key");
  }
  const key = createPublicKey(config.publicKeyPem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error(
      "RS256 verifier requires an RSA public key of at least 2048 bits",
    );
  }
  return async (token) => {
    if (token.length > 4096) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (!encodedHeader || !encodedClaims || !encodedSignature) return null;
    const header = decodePart(encodedHeader);
    const claims = decodePart(encodedClaims);
    if (!record(header) || !record(claims)) return null;
    if (
      header.alg !== "RS256" ||
      header.typ !== "JWT" ||
      header.kid !== config.keyId ||
      header.crit !== undefined ||
      header.jku !== undefined ||
      header.jwk !== undefined ||
      header.x5u !== undefined ||
      header.x5c !== undefined
    )
      return null;
    if (!base64Url.test(encodedSignature)) return null;
    const signature = Buffer.from(encodedSignature, "base64url");
    if (signature.toString("base64url") !== encodedSignature) return null;
    const valid = verifySignature(
      "RSA-SHA256",
      Buffer.from(encodedHeader + "." + encodedClaims, "ascii"),
      { key, padding: constants.RSA_PKCS1_PADDING },
      signature,
    );
    if (!valid) return null;
    return validateClaims(claims, config, nowSeconds());
  };
}
