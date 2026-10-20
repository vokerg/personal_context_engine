import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@pce/db";
import { cookies, secretHash, type SessionAuth } from "./session-auth.js";
const scopeSchema = z.enum(["notes:read", "capture:write"]);
const clientSchema = z
  .object({
    clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    redirectUris: z.array(z.string().url().max(2048)).min(1).max(8),
    scopes: z.array(scopeSchema).min(1).max(2),
  })
  .strict();
export type OAuthClient = z.infer<typeof clientSchema>;
export function oauthClients(env: NodeJS.ProcessEnv): OAuthClient[] {
  if (env.PCE_MCP_ENABLED && !["true", "false"].includes(env.PCE_MCP_ENABLED))
    throw new Error("Invalid MCP flag");
  if (env.PCE_MCP_ENABLED !== "true") return [];
  const clients = z
    .array(clientSchema)
    .min(1)
    .max(16)
    .parse(JSON.parse(env.PCE_OAUTH_CLIENTS ?? "[]"));
  if (new Set(clients.map((c) => c.clientId)).size !== clients.length)
    throw new Error("Duplicate OAuth client");
  for (const c of clients)
    for (const uri of c.redirectUris) {
      const u = new URL(uri);
      if (
        u.hash ||
        u.username ||
        u.password ||
        (u.protocol !== "https:" &&
          !(
            u.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
          ))
      )
        throw new Error("Unsafe OAuth redirect");
      if (
        u.searchParams.has("code") ||
        u.searchParams.has("state") ||
        u.searchParams.has("error") ||
        u.searchParams.has("iss")
      )
        throw new Error("Reserved redirect parameter");
    }
  return clients;
}
const authorizeSchema = z
  .object({
    response_type: z.literal("code"),
    client_id: z.string().max(128),
    redirect_uri: z.string().max(2048),
    resource: z.string().max(256),
    scope: z.string().min(1).max(100),
    state: z.string().min(16).max(512),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
  })
  .strict();
const codeTokenSchema = z
  .object({
    grant_type: z.literal("authorization_code"),
    code: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
    client_id: z.string().max(128),
    redirect_uri: z.string().max(2048),
    resource: z.string().max(256),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  })
  .strict();
const refreshSchema = z
  .object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().max(128),
    client_id: z.string().max(128),
    resource: z.string().max(256),
  })
  .strict();
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function registerOAuth(
  app: FastifyInstance,
  db: PrismaClient,
  auth: SessionAuth,
  clients: OAuthClient[],
) {
  const { issuer, audience, origin } = auth.config;
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16384 },
    (_req, body, done) => {
      const values = new URLSearchParams(String(body));
      const keys = [...values.keys()];
      if (new Set(keys).size !== keys.length)
        return done(new Error("Invalid form"));
      done(null, Object.fromEntries(values));
    },
  );
  const validate = (raw: unknown) => {
    const p = authorizeSchema.parse(raw);
    const client = clients.find((c) => c.clientId === p.client_id);
    const scopes = p.scope.split(" ");
    if (
      !client ||
      !client.redirectUris.includes(p.redirect_uri) ||
      p.resource !== audience ||
      !scopes.length ||
      new Set(scopes).size !== scopes.length ||
      scopes.some(
        (s) => !client.scopes.includes(s as z.infer<typeof scopeSchema>),
      )
    )
      throw new Error("Invalid authorization");
    return p;
  };
  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: issuer + "/oauth/authorize",
    token_endpoint: issuer + "/oauth/token",
    revocation_endpoint: issuer + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["notes:read", "capture:write"],
    client_id_metadata_document_supported: false,
  }));
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])
    app.get(path, async () => ({
      resource: audience,
      authorization_servers: [issuer],
      scopes_supported: ["notes:read", "capture:write"],
      bearer_methods_supported: ["header"],
    }));
  app.get("/oauth/authorize", async (request, reply) => {
    let p;
    try {
      p = validate(request.query);
    } catch {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const session = await auth.browserSession(request);
    if (!session) {
      const target = new URL(origin);
      target.searchParams.set("authorize", new URLSearchParams(p).toString());
      return reply.redirect(target.toString());
    }
    const csrf = cookies(request.headers.cookie).pce_csrf;
    if (!csrf || secretHash(csrf) !== session.csrfHash)
      return reply.code(403).send({ error: "access_denied" });
    const fields = { ...p, csrf };
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    return reply.type("text/html; charset=utf-8").send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Authorize PCE client</title></head><body><h1>Authorize PCE client</h1><p>Client: ${escape(p.client_id)}</p><p>Allow ${escape(p.scope)} for your notes. Read access shares retrieved private text with this client. Capture access stores only explicitly supplied text; it cannot execute actions.</p><form method="post" action="/oauth/authorize">${Object.entries(
        fields,
      )
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`,
        )
        .join(
          "",
        )}<button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form></body></html>`,
    );
  });
  app.post("/oauth/authorize", async (request, reply) => {
    const raw = z
      .object({
        csrf: z.string().max(128),
        decision: z.enum(["allow", "deny"]),
      })
      .passthrough()
      .safeParse(request.body);
    if (!raw.success) return reply.code(400).send({ error: "invalid_request" });
    const { csrf, decision, ...parameters } = raw.data;
    let p;
    try {
      p = validate(parameters);
    } catch {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const session = await auth.browserSession(request),
      cookie = cookies(request.headers.cookie).pce_csrf;
    if (
      !session ||
      request.headers.origin !== issuer ||
      cookie !== csrf ||
      secretHash(csrf) !== session.csrfHash
    )
      return reply.code(403).send({ error: "access_denied" });
    const target = new URL(p.redirect_uri);
    target.searchParams.set("state", p.state);
    target.searchParams.set("iss", issuer);
    if (decision === "deny") {
      target.searchParams.set("error", "access_denied");
      return reply.code(303).redirect(target.toString());
    }
    const code = randomBytes(48).toString("base64url");
    await db.oAuthCode.create({
      data: {
        codeHash: secretHash(code),
        sessionId: session.id,
        clientId: p.client_id,
        redirectUri: p.redirect_uri,
        resource: audience,
        scopes: p.scope.split(" "),
        challenge: p.code_challenge,
        expiresAt: new Date(auth.now().getTime() + 120000),
      },
    });
    target.searchParams.set("code", code);
    return reply.code(303).redirect(target.toString());
  });
  // Global process bound is appropriate for this explicit single-owner deployment.
  let windowAt = 0,
    count = 0;
  const rate = () => {
    if (auth.now().getTime() - windowAt >= 60000) {
      windowAt = auth.now().getTime();
      count = 0;
    }
    return ++count <= 30;
  };
  app.post("/oauth/token", async (request, reply) => {
    if (!rate())
      return reply.code(429).send({ error: "temporarily_unavailable" });
    const refresh = refreshSchema.safeParse(request.body);
    if (refresh.success) {
      const p = refresh.data;
      if (
        p.resource !== audience ||
        !clients.some((c) => c.clientId === p.client_id)
      )
        return reply.code(400).send({ error: "invalid_grant" });
      const result = await auth.refresh(p.refresh_token, p.client_id);
      const client = clients.find((c) => c.clientId === p.client_id)!;
      if (
        result &&
        result.scope
          .split(" ")
          .some(
            (s) => !client.scopes.includes(s as z.infer<typeof scopeSchema>),
          )
      ) {
        await auth.repo.revokeGrant(secretHash(result.access_token));
        return reply.code(400).send({ error: "invalid_grant" });
      }
      return result ?? reply.code(400).send({ error: "invalid_grant" });
    }
    const parsed = codeTokenSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_request" });
    const p = parsed.data,
      challenge = createHash("sha256")
        .update(p.code_verifier)
        .digest("base64url");
    const client = clients.find((c) => c.clientId === p.client_id);
    if (
      p.resource !== audience ||
      !client?.redirectUris.includes(p.redirect_uri)
    )
      return reply.code(400).send({ error: "invalid_grant" });
    const code = await db.oAuthCode.findFirst({
      where: {
        codeHash: secretHash(p.code),
        clientId: p.client_id,
        redirectUri: p.redirect_uri,
        resource: audience,
        challenge,
        consumedAt: null,
        expiresAt: { gt: auth.now() },
        session: {
          ownerSubject: auth.config.ownerSubject,
          issuer,
          audience,
          revokedAt: null,
          expiresAt: { gt: auth.now() },
          absoluteExpiresAt: { gt: auth.now() },
        },
      },
    });
    if (
      !code ||
      code.scopes.some(
        (s) => !client.scopes.includes(s as z.infer<typeof scopeSchema>),
      )
    )
      return reply.code(400).send({ error: "invalid_grant" });
    const consumed = await db.oAuthCode.updateMany({
      where: {
        codeHash: code.codeHash,
        consumedAt: null,
        expiresAt: { gt: auth.now() },
      },
      data: { consumedAt: auth.now() },
    });
    if (consumed.count !== 1)
      return reply.code(400).send({ error: "invalid_grant" });
    try {
      return await auth.issueGrant(code.sessionId, code.scopes, code.clientId);
    } catch {
      return reply.code(400).send({ error: "invalid_grant" });
    }
  });
  app.post("/oauth/revoke", async (request, reply) => {
    if (!rate())
      return reply.code(429).send({ error: "temporarily_unavailable" });
    const p = z
      .object({
        token: z.string().max(128),
        client_id: z.string().max(128),
        token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: "invalid_request" });
    if (clients.some((c) => c.clientId === p.data.client_id))
      await db.apiGrant.updateMany({
        where: {
          clientId: p.data.client_id,
          OR: [
            { accessHash: secretHash(p.data.token) },
            { refreshHash: secretHash(p.data.token) },
          ],
          session: { ownerSubject: auth.config.ownerSubject, issuer, audience },
        },
        data: { revokedAt: auth.now() },
      });
    return reply.code(200).send({});
  });
}
