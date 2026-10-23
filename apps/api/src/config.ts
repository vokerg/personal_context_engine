import { createPublicKey } from "node:crypto";

/** Server-side configuration only; no credentials or private data are serialized. */
export interface ApiAuthConfig {
  issuer: string;
  audience: string;
  /** Server-only HS256 key, at least 32 UTF-8 bytes. */
  secret: string;
}

/** Static trusted issuer key, never a JWT-controlled jku/jwk fetch. */
export interface ApiRs256AuthConfig {
  issuer: string;
  audience: string;
  keyId: string;
  publicKeyPem: string;
}

export interface ApiConfig {
  host: string;
  port: number;
  environment: "development" | "test" | "production";
  corsOrigin: string | null;
  requiresDatabase: boolean;
  auth: ApiAuthConfig | null;
  rs256Auth?: ApiRs256AuthConfig;
}

function parseOrigin(
  value: string,
  environment: ApiConfig["environment"],
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API_CORS_ORIGIN must be one exact HTTP(S) origin");
  }
  if (
    url.origin !== value ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("API_CORS_ORIGIN must be one exact HTTP(S) origin");
  }
  if (
    environment === "production" &&
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Production CORS origins must use HTTPS");
  }
  return value;
}

/** This storage/API foundation is not a production research-capture release gate.
 * Keep the new routes absent unless an operator deliberately enables them.
 * Invalid values fail closed instead of silently changing feature availability.
 */
export function researchReportsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PCE_RESEARCH_REPORTS;
  if (value !== undefined && value !== "true" && value !== "false")
    throw new Error("PCE_RESEARCH_REPORTS must be true or false");
  return value === "true";
}

/** Explicit environment injection makes config tests independent of process.env. */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(environment)) {
    throw new Error("NODE_ENV must be development, test or production");
  }
  const mode = environment as ApiConfig["environment"];
  const portValue = env.API_PORT ?? env.PORT ?? "3000";
  if (!/^[0-9]{1,5}$/.test(portValue)) {
    throw new Error("API_PORT must be a valid TCP port");
  }
  const port = Number(portValue);
  if (port < 1 || port > 65535) {
    throw new Error("API_PORT must be a valid TCP port");
  }
  const host = env.API_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(host)) {
    throw new Error("API_HOST must be a supported bind address");
  }
  if (
    env.API_REQUIRE_DB !== undefined &&
    !["true", "false"].includes(env.API_REQUIRE_DB)
  ) {
    throw new Error("API_REQUIRE_DB must be true or false");
  }
  if (env.DATABASE_URL !== undefined && !env.DATABASE_URL.trim()) {
    throw new Error("DATABASE_URL must not be empty when configured");
  }
  const requiresDatabase =
    env.API_REQUIRE_DB === "true" || env.DATABASE_URL !== undefined;
  const corsOrigin = env.API_CORS_ORIGIN
    ? parseOrigin(env.API_CORS_ORIGIN, mode)
    : null;
  const issuer = env.API_AUTH_ISSUER;
  const audience = env.API_AUTH_AUDIENCE;
  const secret = env.API_AUTH_HS256_SECRET;
  const publicKeyPem = env.API_AUTH_RS256_PUBLIC_KEY_PEM;
  const keyId = env.API_AUTH_RS256_KEY_ID;
  const anyAuthConfigured = [
    issuer,
    audience,
    secret,
    publicKeyPem,
    keyId,
  ].some((value) => value !== undefined);
  if (
    mode === "production" &&
    !anyAuthConfigured &&
    env.PCE_AUTH_MODE !== "single-user"
  ) {
    throw new Error("Production requires authenticated API configuration");
  }
  let auth: ApiAuthConfig | null = null;
  let rs256Auth: ApiRs256AuthConfig | undefined;
  if (anyAuthConfigured) {
    if (
      !issuer ||
      !audience ||
      issuer.trim() !== issuer ||
      audience.trim() !== audience ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(issuer) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(audience) ||
      (secret !== undefined &&
        (publicKeyPem !== undefined || keyId !== undefined))
    ) {
      throw new Error(
        "API authentication requires one complete, exclusive token verifier",
      );
    }
    if (secret !== undefined) {
      if (Buffer.byteLength(secret, "utf8") < 32) {
        throw new Error("HS256 signing key must be at least 32 UTF-8 bytes");
      }
      auth = { issuer, audience, secret };
    } else {
      if (
        !publicKeyPem ||
        !keyId ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId)
      ) {
        throw new Error("RS256 requires a public key and pinned key ID");
      }
      try {
        if (!publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")) {
          throw new Error("only SPKI public keys are allowed");
        }
        const key = createPublicKey(publicKeyPem);
        if (
          key.asymmetricKeyType !== "rsa" ||
          (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
        ) {
          throw new Error("invalid RSA modulus");
        }
      } catch {
        throw new Error(
          "RS256 requires a valid RSA public key of at least 2048 bits",
        );
      }
      rs256Auth = { issuer, audience, publicKeyPem, keyId };
    }
  }
  return {
    host,
    port,
    environment: mode,
    corsOrigin,
    requiresDatabase,
    auth,
    ...(rs256Auth ? { rs256Auth } : {}),
  };
}
