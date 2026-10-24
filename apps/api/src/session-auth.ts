import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createSessionRepository, type PrismaClient } from "@pce/db";
import type { AuthenticatedPrincipal } from "./auth.js";

export interface SessionConfig {
  mode: "single-user" | "dev-single-user";
  ownerSubject: string;
  origin: string;
  /** Additional equivalent loopback web origins for local development. */
  allowedOrigins?: readonly string[];
  issuer: string;
  audience: string;
  secure: boolean;
  username?: string;
  passwordHash?: string;
}
export function sessionConfig(
  env: NodeJS.ProcessEnv,
): SessionConfig | undefined {
  if (!env.PCE_AUTH_MODE) return;
  if (!["single-user", "dev-single-user"].includes(env.PCE_AUTH_MODE))
    throw new Error("Invalid authentication mode");
  const mode = env.PCE_AUTH_MODE as SessionConfig["mode"];
  const origin = new URL(env.PCE_WEB_ORIGIN ?? "http://127.0.0.1:4310").origin;
  const issuer = new URL(env.PCE_API_ORIGIN ?? "http://127.0.0.1:3110").origin;
  const loopback = (value: string) =>
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  if (new URL(origin).hostname !== new URL(issuer).hostname)
    throw new Error("Sessions require one hostname");
  const secure = origin.startsWith("https:") && issuer.startsWith("https:");
  if (
    (!secure && (!loopback(origin) || !loopback(issuer))) ||
    (mode === "dev-single-user" &&
      (env.NODE_ENV === "production" ||
        !loopback(origin) ||
        !loopback(issuer) ||
        (env.API_HOST && env.API_HOST !== "127.0.0.1")))
  )
    throw new Error("Insecure authentication deployment");
  const ownerSubject = env.PCE_OWNER_SUBJECT ?? "local-developer";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(ownerSubject))
    throw new Error("Invalid trusted owner");
  const username = env.PCE_SINGLE_USER_USERNAME;
  const passwordHash = env.PCE_SINGLE_USER_PASSWORD_HASH;
  if (
    mode === "single-user" &&
    (!username ||
      username.length > 100 ||
      !/^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{128}$/.test(passwordHash ?? ""))
  )
    throw new Error("Single-user credentials required");
  return {
    mode,
    ownerSubject,
    origin,
    issuer,
    audience: issuer + "/mcp",
    secure,
    ...(username ? { username } : {}),
    ...(passwordHash ? { passwordHash } : {}),
  };
}
export const secretHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(48).toString("base64url");
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function cookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (header ?? "").split(";").flatMap((part) => {
      const at = part.indexOf("=");
      if (at < 1) return [];
      try {
        return [
          [
            part.slice(0, at).trim(),
            decodeURIComponent(part.slice(at + 1).trim()),
          ],
        ];
      } catch {
        return [];
      }
    }),
  );
}
export function createSessionAuth(
  db: PrismaClient,
  config: SessionConfig,
  now = () => new Date(),
) {
  const repo = createSessionRepository(db);
  let windowAt = 0,
    attempts = 0,
    busy = false;
  const activeSession = (hash: string) =>
    repo.findSession(
      hash,
      config.ownerSubject,
      config.issuer,
      config.audience,
      now(),
    );
  const issuePair = () => ({
    access_token: token(),
    refresh_token: token(),
    token_type: "Bearer" as const,
    expires_in: 900,
  });
  const cookieHeaders = (sessionToken: string, csrf: string) => {
    const common = `Path=/; SameSite=Lax${config.secure ? "; Secure" : ""}; Max-Age=604800`;
    return [
      `pce_session=${sessionToken}; ${common}; HttpOnly`,
      `pce_csrf=${csrf}; ${common}`,
    ];
  };
  const originAllowed = (request: FastifyRequest) =>
    typeof request.headers.origin === "string" &&
    (config.allowedOrigins ?? [config.origin]).includes(request.headers.origin);
  return {
    config,
    repo,
    now,
    issuePair,
    async login(input: unknown, request: FastifyRequest, development = false) {
      if (!originAllowed(request))
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
      if (
        development &&
        (config.mode !== "dev-single-user" ||
          !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip))
      )
        throw Object.assign(new Error("Unavailable"), { statusCode: 404 });
      if (now().getTime() - windowAt >= 60_000) {
        windowAt = now().getTime();
        attempts = 0;
      }
      if (busy || attempts >= 10)
        throw Object.assign(new Error("Rate limit"), { statusCode: 429 });
      attempts++;
      if (
        development &&
        input !== undefined &&
        (!input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length)
      )
        throw Object.assign(new Error("Invalid local bootstrap"), {
          statusCode: 400,
        });
      if (!development) {
        if (
          config.mode !== "single-user" ||
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some((k) => !["username", "password"].includes(k))
        )
          throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
        const { username, password } = input as Record<string, unknown>;
        if (
          typeof username !== "string" ||
          username.length > 100 ||
          typeof password !== "string" ||
          !password ||
          password.length > 256
        )
          throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
        busy = true;
        try {
          const [, salt, expected] = config.passwordHash!.split(":");
          const derived = await new Promise<Buffer>((resolve, reject) =>
            scrypt(
              password,
              Buffer.from(salt!, "hex"),
              64,
              { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
              (err, key) => (err ? reject(err) : resolve(key)),
            ),
          );
          if (
            !equal(secretHash(username), secretHash(config.username!)) ||
            !equal(derived.toString("hex"), expected!)
          )
            throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
        } finally {
          busy = false;
        }
      }
      const sessionToken = token(),
        csrf = token(),
        time = now();
      const session = await repo.createSession({
        ownerSubject: config.ownerSubject,
        issuer: config.issuer,
        audience: config.audience,
        tokenHash: secretHash(sessionToken),
        csrfHash: secretHash(csrf),
        expiresAt: new Date(time.getTime() + 43_200_000),
        absoluteExpiresAt: new Date(time.getTime() + 604_800_000),
      });
      return { session, cookieHeaders: cookieHeaders(sessionToken, csrf) };
    },
    async browserSession(request: FastifyRequest) {
      const value = cookies(request.headers.cookie).pce_session;
      if (!value || !/^[A-Za-z0-9_-]{64}$/.test(value)) return null;
      const session = await activeSession(secretHash(value));
      if (session && now().getTime() - session.lastSeenAt.getTime() > 300_000) {
        const expiresAt = new Date(
          Math.min(
            now().getTime() + 43_200_000,
            session.absoluteExpiresAt.getTime(),
          ),
        );
        await repo.touchSession(session.id, now(), expiresAt);
        session.expiresAt = expiresAt;
      }
      return session;
    },
    csrf(request: FastifyRequest, session: { csrfHash: string }) {
      const cookie = cookies(request.headers.cookie).pce_csrf;
      const header = request.headers["x-pce-csrf"];
      return (
        originAllowed(request) &&
        typeof header === "string" &&
        !!cookie &&
        equal(cookie, header) &&
        equal(secretHash(header), session.csrfHash)
      );
    },
    async verifyAccessToken(
      accessToken: string,
    ): Promise<AuthenticatedPrincipal | null> {
      if (!/^[A-Za-z0-9_-]{64}$/.test(accessToken)) return null;
      const grant = await repo.findGrant(
        secretHash(accessToken),
        config.ownerSubject,
        config.issuer,
        config.audience,
        now(),
      );
      return grant
        ? { subject: grant.session.ownerSubject, scopes: grant.scopes }
        : null;
    },
    async issueGrant(
      sessionId: string,
      scopes: string[],
      clientId = "pce-local",
      options: { persistent?: boolean } = {},
    ) {
      if (
        !scopes.length ||
        scopes.some(
          (x) => !["notes:read", "capture:write", "tags:write"].includes(x),
        )
      )
        throw Object.assign(new Error("Invalid scope"), { statusCode: 400 });
      const session = await db.authSession.findFirst({
        where: {
          id: sessionId,
          ownerSubject: config.ownerSubject,
          issuer: config.issuer,
          audience: config.audience,
          revokedAt: null,
          expiresAt: { gt: now() },
          absoluteExpiresAt: { gt: now() },
        },
      });
      if (!session)
        throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
      const pair = issuePair();
      await repo.createGrant({
        sessionId,
        clientId,
        audience: config.audience,
        scopes,
        accessHash: secretHash(pair.access_token),
        refreshHash: secretHash(pair.refresh_token),
        expiresAt: new Date(now().getTime() + 900_000),
        refreshExpiresAt: options.persistent ? null : session.absoluteExpiresAt,
      });
      return { ...pair, scope: scopes.join(" ") };
    },
    async refresh(refreshToken: string, clientId: string) {
      if (!/^[A-Za-z0-9_-]{64}$/.test(refreshToken)) return null;
      const grant = await repo.findRefresh(
        secretHash(refreshToken),
        clientId,
        config.ownerSubject,
        config.issuer,
        config.audience,
        now(),
      );
      if (!grant) return null;
      const pair = issuePair();
      if (
        !(await repo.rotateGrant(
          grant.id,
          secretHash(refreshToken),
          secretHash(pair.access_token),
          secretHash(pair.refresh_token),
          new Date(now().getTime() + 900_000),
        ))
      )
        return null;
      return { ...pair, scope: grant.scopes.join(" ") };
    },
    clearCookies: () => [
      "pce_session=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0",
      "pce_csrf=; Path=/; SameSite=Lax; Max-Age=0",
    ],
  };
}
export type SessionAuth = ReturnType<typeof createSessionAuth>;
export async function requireSessionScope(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: SessionAuth,
  scope: string,
) {
  let principal: AuthenticatedPrincipal | null = null;
  if (request.headers.authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9_-]{64})$/i.exec(
      request.headers.authorization,
    );
    if (match) principal = await auth.verifyAccessToken(match[1]!);
  } else {
    const session = await auth.browserSession(request);
    if (session) {
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        !auth.csrf(request, session)
      )
        return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      principal = {
        subject: session.ownerSubject,
        scopes: ["notes:read", "capture:write", "tags:write"],
      };
    }
  }
  if (!principal)
    return reply
      .header("WWW-Authenticate", "Bearer")
      .code(401)
      .send({ error: { code: "UNAUTHORIZED" } });
  if (!principal.scopes.includes(scope))
    return reply.code(403).send({ error: { code: "FORBIDDEN" } });
  request.authenticatedPrincipal = principal;
}
export function registerSessionRoutes(app: FastifyInstance, auth: SessionAuth) {
  const dto = (s: { expiresAt: Date; absoluteExpiresAt: Date }) => ({
    authenticated: true,
    expiresAt: s.expiresAt.toISOString(),
    absoluteExpiresAt: s.absoluteExpiresAt.toISOString(),
  });
  app.get("/auth/config", async () => ({ mode: auth.config.mode }));
  for (const [path, development] of [
    ["/auth/password", false],
    ["/auth/dev-session", true],
  ] as const) {
    if (development && auth.config.mode !== "dev-single-user") continue;
    app.post(path, async (request, reply) => {
      const result = await auth.login(request.body, request, development);
      return reply
        .header("Set-Cookie", result.cookieHeaders)
        .send(dto(result.session));
    });
  }
  app.get("/auth/session", async (request, reply) => {
    const session = await auth.browserSession(request);
    return session
      ? dto(session)
      : reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
  });
  app.post("/auth/logout", async (request, reply) => {
    const session = await auth.browserSession(request);
    if (!session)
      return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    if (!auth.csrf(request, session))
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    await auth.repo.revokeSession(session.id);
    return reply
      .header("Set-Cookie", auth.clearCookies())
      .send({ signedOut: true });
  });
  app.post("/auth/token", async (request, reply) => {
    const session = await auth.browserSession(request);
    if (!session)
      return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    if (!auth.csrf(request, session))
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    const body = request.body as Record<string, unknown> | undefined;
    if (
      !body ||
      Object.keys(body).some((k) => k !== "scope") ||
      typeof body.scope !== "string"
    )
      return reply.code(400).send({ error: { code: "BAD_REQUEST" } });
    return auth.issueGrant(session.id, body.scope.split(" ").filter(Boolean));
  });
}
