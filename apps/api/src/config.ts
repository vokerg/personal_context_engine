/** Server-side configuration only; no credentials or private data are serialized. */
export interface ApiConfig {
  host: string;
  port: number;
  environment: "development" | "test" | "production";
  corsOrigin: string | null;
  requiresDatabase: boolean;
}

function parseOrigin(value: string, environment: ApiConfig["environment"]): string {
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

/** Explicit environment injection makes config tests independent of process.env. */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(environment)) {
    throw new Error("NODE_ENV must be development, test or production");
  }
  const mode = environment as ApiConfig["environment"];
  const portValue = env.API_PORT ?? "3000";
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
  return { host, port, environment: mode, corsOrigin, requiresDatabase };
}
