import { registerMcp, type McpOptions } from "./mcp.js";
import { SearchRequestSchema, SearchResponseSchema } from "@pce/contracts";
import type { SearchService } from "./search.js";
import {
  CaptureRequestSchema,
  CaptureResponseSchema,
  type CaptureRequest,
  type CaptureResponse,
} from "@pce/contracts";
import {
  registerSessionRoutes,
  requireSessionScope,
  type SessionAuth,
} from "./session-auth.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  BrowseQuerySchema,
  BrowsePageSchema,
  BrowseFacetsSchema,
  type BrowseQuery,
  type BrowsePage,
  type BrowseFacets,
  ApiErrorResponseSchema,
  ApiVersionResponseSchema,
  NoteDetailSchema,
  NoteIdSchema,
  NotesListResponseSchema,
  NotesQuerySchema,
  TagFacetsResponseSchema,
  TagRegistryResponseSchema,
  TagApprovalInputSchema,
  TagApprovalMutationResponseSchema,
  TagSlugSchema,
  type NotesQuery,
  type TagFacetsResponse,
  type TagRegistryResponse,
  type TagApprovalInput,
  type TagApprovalMutationResponse,
  type NoteDetail,
  type NotePreview,
  HealthResponseSchema,
  ReadyResponseSchema,
  type ApiErrorResponse,
} from "@pce/contracts";
import { loadApiConfig, type ApiConfig } from "./config.js";
import {
  createHmacTokenVerifier,
  createRs256TokenVerifier,
  isAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
  type TokenVerifier,
} from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    authenticatedPrincipal: AuthenticatedPrincipal | null;
  }
}

/** Owner filtering must occur in the trusted adapter query, not in the client. */
export interface PrivateNoteReader {
  listByOwner(subject: string, filters?: NotesQuery): Promise<NotePreview[]>;
  /** Optional until a trusted owner-filtered facets adapter is attached. */
  listTagsByOwner?(subject: string): Promise<TagFacetsResponse>;
  getByOwner(subject: string, noteId: string): Promise<NoteDetail | null>;
  /** Inject both only behind an explicit trusted browse/search gate. */
  pageByOwner?(subject: string, query: BrowseQuery): Promise<BrowsePage>;
  facetsByOwner?(subject: string): Promise<BrowseFacets>;
}

export interface ApiDependencies {
  mcp?: McpOptions;
  sessionAuth?: SessionAuth;
  search?: SearchService;
  capture?: {
    persistByOwner(
      owner: string,
      input: CaptureRequest,
    ): Promise<CaptureResponse>;
  };
  /** Independent registry: no note source writes, and no GitHub dependency. */
  tagRegistry?: {
    listByOwner(owner: string): Promise<TagRegistryResponse>;
    approveByOwner(
      owner: string,
      slug: string,
      input: TagApprovalInput,
    ): Promise<TagApprovalMutationResponse>;
    unapproveByOwner(
      owner: string,
      slug: string,
    ): Promise<TagApprovalMutationResponse>;
  };
  /** A trusted adapter supplied by the DB integration; never a user request. */
  checkDatabase?: () => Promise<boolean>;
  verifyToken?: TokenVerifier;
  /** Omit to keep all private routes disabled until a vetted adapter exists. */
  notes?: PrivateNoteReader;
}

export interface ApiOptions {
  config?: ApiConfig;
  dependencies?: ApiDependencies;
}

type ErrorCode = ApiErrorResponse["error"]["code"];

function errorResponse(code: ErrorCode): ApiErrorResponse {
  return ApiErrorResponseSchema.parse({ error: { code } });
}

/** Public diagnostics plus explicitly gated, owner-scoped private reads. */
export function createApp(options: ApiOptions = {}) {
  const config = options.config ?? loadApiConfig();
  const checkDatabase = options.dependencies?.checkDatabase;
  const notes = options.dependencies?.notes;
  const sessionAuth = options.dependencies?.sessionAuth;
  const verifyToken =
    options.dependencies?.verifyToken ??
    (config.rs256Auth
      ? createRs256TokenVerifier(config.rs256Auth)
      : config.auth
        ? createHmacTokenVerifier(config.auth)
        : undefined);
  if (notes && !verifyToken && !sessionAuth) {
    throw new Error("Private notes require an authenticated token verifier");
  }
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

  if (options.dependencies?.mcp) {
    const { mcp, search, capture } = options.dependencies;
    if (!sessionAuth || !search || !capture)
      throw new Error("MCP requires sessions, search and durable capture");
    registerMcp(app, mcp, sessionAuth, search, capture);
  }

  app.decorateRequest("authenticatedPrincipal", null);

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
      if (sessionAuth) reply.header("Access-Control-Allow-Credentials", "true");
    }
    if (
      request.method === "OPTIONS" &&
      request.headers["access-control-request-method"] !== undefined
    ) {
      if (
        !allowed ||
        !["GET", ...(sessionAuth ? ["POST", "PUT", "DELETE"] : [])].includes(
          String(request.headers["access-control-request-method"]),
        )
      ) {
        return reply.code(403).send(errorResponse("FORBIDDEN"));
      }
      reply.header(
        "Access-Control-Allow-Methods",
        sessionAuth ? "GET, POST, PUT, DELETE" : "GET",
      );
      reply.header(
        "Access-Control-Allow-Headers",
        sessionAuth
          ? "Authorization, Content-Type, X-PCE-CSRF"
          : "Authorization, Content-Type",
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

  if (sessionAuth) registerSessionRoutes(app, sessionAuth);
  if (options.dependencies?.search) {
    if (!sessionAuth) throw new Error("DB search requires scoped sessions");
    const search = options.dependencies.search;
    app.post(
      "/api/v1/search",
      {
        preHandler: (request, reply) =>
          requireSessionScope(request, reply, sessionAuth, "notes:read"),
      },
      async (request, reply) => {
        const input = SearchRequestSchema.safeParse(request.body);
        if (!input.success)
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        try {
          return SearchResponseSchema.parse(
            await search.searchByOwner(
              request.authenticatedPrincipal!.subject,
              input.data,
            ),
          );
        } catch (error) {
          if (error instanceof Error && error.name === "SearchCursorError")
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          throw error;
        }
      },
    );
    app.get(
      "/api/v1/search/notes/:id",
      {
        preHandler: (request, reply) =>
          requireSessionScope(request, reply, sessionAuth, "notes:read"),
      },
      async (request, reply) => {
        const id = NoteIdSchema.safeParse(
          (request.params as { id: string }).id,
        );
        if (!id.success)
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        const note = await search.getByOwner(
          request.authenticatedPrincipal!.subject,
          id.data,
        );
        return note
          ? NoteDetailSchema.parse(note)
          : reply.code(404).send(errorResponse("NOT_FOUND"));
      },
    );
  }

  if (options.dependencies?.capture) {
    if (!sessionAuth)
      throw new Error("Capture requires session authentication");
    const capture = options.dependencies.capture;
    app.post(
      "/api/v1/captures",
      {
        bodyLimit: 262144,
        preHandler: (request, reply) =>
          requireSessionScope(request, reply, sessionAuth, "capture:write"),
      },
      async (request, reply) => {
        const input = CaptureRequestSchema.safeParse(request.body);
        if (!input.success)
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        try {
          return CaptureResponseSchema.parse(
            await capture.persistByOwner(
              request.authenticatedPrincipal!.subject,
              input.data,
            ),
          );
        } catch (error) {
          if (error instanceof Error && error.name === "CaptureConflict")
            return reply.code(409).send(errorResponse("BAD_REQUEST"));
          if (
            error instanceof TypeError ||
            (error instanceof Error && error.name === "NoteValidationError")
          )
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          throw error;
        }
      },
    );
  }

  if (options.dependencies?.tagRegistry) {
    if (!sessionAuth)
      throw new Error("Tag approval writes require scoped sessions");
    const registry = options.dependencies.tagRegistry;
    const read = (request: FastifyRequest, reply: FastifyReply) =>
      requireSessionScope(request, reply, sessionAuth, "notes:read");
    const write = (request: FastifyRequest, reply: FastifyReply) =>
      requireSessionScope(request, reply, sessionAuth, "tags:write");
    app.get(
      "/api/v1/tag-registry",
      { preHandler: read },
      async (request, reply) => {
        if (Object.keys(request.query as object).length)
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        return TagRegistryResponseSchema.parse(
          await registry.listByOwner(request.authenticatedPrincipal!.subject),
        );
      },
    );
    app.put<{ Params: { slug: string } }>(
      "/api/v1/tag-registry/:slug",
      { preHandler: write },
      async (request, reply) => {
        const slug = TagSlugSchema.safeParse(request.params.slug);
        const input = TagApprovalInputSchema.safeParse(request.body);
        if (
          !slug.success ||
          !input.success ||
          Object.keys(request.query as object).length
        )
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        return TagApprovalMutationResponseSchema.parse(
          await registry.approveByOwner(
            request.authenticatedPrincipal!.subject,
            slug.data,
            input.data,
          ),
        );
      },
    );
    app.delete<{ Params: { slug: string } }>(
      "/api/v1/tag-registry/:slug",
      { preHandler: write },
      async (request, reply) => {
        const slug = TagSlugSchema.safeParse(request.params.slug);
        if (
          !slug.success ||
          Object.keys(request.query as object).length ||
          request.body !== undefined
        )
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        return TagApprovalMutationResponseSchema.parse(
          await registry.unapproveByOwner(
            request.authenticatedPrincipal!.subject,
            slug.data,
          ),
        );
      },
    );
  }

  if (notes) {
    const requireNoteRead = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (sessionAuth)
        return requireSessionScope(request, reply, sessionAuth, "notes:read");
      const authorization = request.headers.authorization;
      const match = /^Bearer ([A-Za-z0-9._-]{1,4096})$/i.exec(
        authorization ?? "",
      );
      let principal: AuthenticatedPrincipal | null = null;
      if (match?.[1]) {
        try {
          principal = await verifyToken!(match[1]);
        } catch {
          // Identity provider errors do not grant access or leak credentials.
        }
      }
      if (!isAuthenticatedPrincipal(principal)) {
        reply.header("WWW-Authenticate", "Bearer");
        return reply.code(401).send(errorResponse("UNAUTHORIZED"));
      }
      if (!principal.scopes.includes("notes:read")) {
        return reply.code(403).send(errorResponse("FORBIDDEN"));
      }
      request.authenticatedPrincipal = principal;
    };
    if (notes.pageByOwner && notes.facetsByOwner) {
      app.get(
        "/api/v1/browse",
        { preHandler: requireNoteRead },
        async (request, reply) => {
          const query = BrowseQuerySchema.safeParse(request.query);
          if (!query.success)
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          try {
            return BrowsePageSchema.parse(
              await notes.pageByOwner!(
                request.authenticatedPrincipal!.subject,
                query.data,
              ),
            );
          } catch (error) {
            // The trusted adapter translates its cursor error to this fixed code.
            if (error instanceof Error && error.name === "BrowseCursorError")
              return reply.code(400).send(errorResponse("BAD_REQUEST"));
            throw error;
          }
        },
      );
      app.get(
        "/api/v1/browse/facets",
        { preHandler: requireNoteRead },
        async (request, reply) => {
          if (Object.keys(request.query as object).length)
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          return BrowseFacetsSchema.parse(
            await notes.facetsByOwner!(request.authenticatedPrincipal!.subject),
          );
        },
      );
    }
    app.get(
      "/api/v1/notes",
      { preHandler: requireNoteRead },
      async (request, reply) => {
        const filters = NotesQuerySchema.safeParse(request.query);
        if (!filters.success) {
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        }
        const records = await notes.listByOwner(
          request.authenticatedPrincipal!.subject,
          filters.data,
        );
        return NotesListResponseSchema.parse({ notes: records });
      },
    );
    if (notes.listTagsByOwner) {
      app.get(
        "/api/v1/tags",
        { preHandler: requireNoteRead },
        async (request, reply) => {
          if (Object.keys(request.query as Record<string, unknown>).length) {
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          }
          return TagFacetsResponseSchema.parse(
            await notes.listTagsByOwner!(
              request.authenticatedPrincipal!.subject,
            ),
          );
        },
      );
    }
    app.get<{ Params: { id: string } }>(
      "/api/v1/notes/:id",
      { preHandler: requireNoteRead },
      async (request, reply) => {
        if (!NoteIdSchema.safeParse(request.params.id).success) {
          return reply.code(404).send(errorResponse("NOT_FOUND"));
        }
        const record = await notes.getByOwner(
          request.authenticatedPrincipal!.subject,
          request.params.id,
        );
        if (!record) return reply.code(404).send(errorResponse("NOT_FOUND"));
        return NoteDetailSchema.parse(record);
      },
    );
  }
  return app;
}
