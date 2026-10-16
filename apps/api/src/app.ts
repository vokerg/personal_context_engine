import Fastify from "fastify";
import {
  ApiErrorResponseSchema,
  ApiVersionResponseSchema,
  HealthResponseSchema,
  ReadyResponseSchema,
  type ApiErrorResponse,
} from "@pce/contracts";
import { loadApiConfig, type ApiConfig } from "./config.js";

export interface ApiDependencies {
  /** A trusted adapter supplied by the DB integration; never a user request. */
  checkDatabase?: () => Promise<boolean>;
}

export interface ApiOptions {
  config?: ApiConfig;
  dependencies?: ApiDependencies;
}

type ErrorCode = ApiErrorResponse["error"]["code"];

function errorResponse(code: ErrorCode): ApiErrorResponse {
  return ApiErrorResponseSchema.parse({ error: { code } });
}

/** Public-only API shell. Private routes MUST NOT be added until auth (#13). */
export function createApp(options: ApiOptions = {}) {
  const config = options.config ?? loadApiConfig();
  const checkDatabase = options.dependencies?.checkDatabase;
  if (config.requiresDatabase && !checkDatabase) {
    throw new Error("Mandatory database dependency has no readiness adapter");
  }

  // Never log headers, tokens, query strings, or personal note content by default.
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 16 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");

    const origin = request.headers.origin;
    const allowed = !!origin && origin === config.corsOrigin;
    if (allowed) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
    }
    if (
      request.method === "OPTIONS" &&
      request.headers["access-control-request-method"] !== undefined
    ) {
      if (
        !allowed ||
        request.headers["access-control-request-method"] !== "GET"
      ) {
        return reply.code(403).send(errorResponse("FORBIDDEN"));
      }
      reply.header("Access-Control-Allow-Methods", "GET");
      reply.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      return reply.code(204).send();
    }
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorResponse("NOT_FOUND")),
  );
  app.setErrorHandler((error, _request, reply) => {
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const safeStatus =
      typeof status === "number" && status >= 400 && status < 600
        ? status
        : 500;
    const code: ErrorCode =
      safeStatus === 400
        ? "BAD_REQUEST"
        : safeStatus === 401
          ? "UNAUTHORIZED"
          : safeStatus === 403
            ? "FORBIDDEN"
            : safeStatus === 404
              ? "NOT_FOUND"
              : safeStatus === 503
                ? "SERVICE_UNAVAILABLE"
                : "INTERNAL_ERROR";
    // No exception message, URL, request headers or stack in the response.
    return reply.code(safeStatus).send(errorResponse(code));
  });

  app.get("/health", async () => HealthResponseSchema.parse({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    let ready = true;
    if (config.requiresDatabase) {
      try {
        ready = (await checkDatabase!()) === true;
      } catch {
        ready = false;
      }
    }
    if (!ready) reply.code(503);
    return ReadyResponseSchema.parse({
      status: ready ? "ready" : "not_ready",
    });
  });
  app.get("/api/v1", async () =>
    ApiVersionResponseSchema.parse({ version: "v1" }),
  );
  return app;
}
