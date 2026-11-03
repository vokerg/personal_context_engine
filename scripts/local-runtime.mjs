import { createHmac } from "node:crypto";

export const subject = "local-developer";
export const issuer = "pce-local-development";
export const audience = "pce-api";

export function localConfig(env) {
  if (env.NODE_ENV && env.NODE_ENV !== "development")
    throw new Error("Local startup requires development mode.");
  if (env.API_HOST && env.API_HOST !== "127.0.0.1")
    throw new Error("Local startup requires API_HOST=127.0.0.1.");
  if (
    env.PCE_LOCAL_BROWSE !== undefined &&
    !["true", "false"].includes(env.PCE_LOCAL_BROWSE)
  )
    throw new Error("PCE_LOCAL_BROWSE must be true or false");
  if (!env.DATABASE_URL) throw new Error("Set DATABASE_URL in the root .env.");
  const port = (value, fallback) => {
    if (value !== undefined && !/^\d{1,5}$/.test(value))
      throw new Error("Invalid local port.");
    const result = Number(value ?? fallback);
    if (result < 1024 || result > 65535) throw new Error("Invalid local port.");
    return result;
  };
  const apiPort = port(env.API_PORT, 3110);
  const webPort = port(env.PCE_WEB_PORT, 4310);
  if (apiPort === webPort) throw new Error("API and web ports must differ.");
  const origins = [
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
  ];
  return {
    apiPort,
    webPort,
    browseEnabled:
      env.PCE_LOCAL_BROWSE === "true" || env.PCE_DB_SEARCH === "true",
    searchEnabled: env.PCE_DB_SEARCH === "true",
    origin: origins[0],
    origins,
  };
}

// Validate every file before making any DB write. Never follow content symlinks.
export function mintSession(secret, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const data =
    encode({ alg: "HS256", typ: "JWT" }) +
    "." +
    encode({
      iss: issuer,
      aud: audience,
      sub: subject,
      scope: "notes:read",
      iat: now,
      exp: now + 900,
    });
  return (
    data + "." + createHmac("sha256", secret).update(data).digest("base64url")
  );
}

export function sessionAllowed(request, origins) {
  const allowedOrigins = (Array.isArray(origins) ? origins : [origins]).map(
    (value) => new URL(value).origin,
  );
  const hostOrigin = allowedOrigins.find(
    (value) => new URL(value).host === request.headers.host,
  );
  return (
    request.method === "GET" &&
    hostOrigin !== undefined &&
    (!request.headers.origin || request.headers.origin === hostOrigin) &&
    [undefined, "same-origin", "none"].includes(
      request.headers["sec-fetch-site"],
    ) &&
    ["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
  );
}
