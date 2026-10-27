import { TagRegistryQuerySchema, type TagRegistryQuery } from "@pce/contracts";
import {
  registerTaskRoutes,
  registerTaskBatchRoutes,
  type TaskService,
  type TaskExtractionService,
} from "./tasks.js";
import { registerMcp, type McpOptions } from "./mcp.js";
import { registerOAuth, type OAuthClient } from "./oauth.js";
import type { PrismaClient } from "@pce/db";
import { SearchRequestSchema, SearchResponseSchema } from "@pce/contracts";
import {
  ResearchSaveRequestSchema,
  ResearchReceiptSchema,
  ResearchRecordSchema,
  ResearchListSchema,
  type ResearchSaveRequest,
  type ResearchReceipt,
  type ResearchRecord,
} from "@pce/contracts";
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
  BrowseStatusQuerySchema,
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
  NoteTagEditRequestSchema,
  NoteTagEditResponseSchema,
  NoteRemovalResponseSchema,
  NoteArchiveRequestSchema,
  NoteArchiveResponseSchema,
  TagSlugSchema,
  type NotesQuery,
  type TagFacetsResponse,
  type TagRegistryResponse,
  type TagApprovalInput,
  type TagApprovalMutationResponse,
  type NoteTagEditRequest,
  type NoteTagEditResponse,
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
  listTagsByOwner?(
    subject: string,
    status?: "active" | "archived" | "all",
  ): Promise<TagFacetsResponse>;
  getByOwner(subject: string, noteId: string): Promise<NoteDetail | null>;
  /** Explicit owner-scoped removal; preserves the source projection. */
  removeByOwner?(subject: string, noteId: string): Promise<boolean>;
  setArchivedByOwner?(
    subject: string,
    noteId: string,
    archived: boolean,
  ): Promise<"active" | "archived" | null>;
  /** Inject both only behind an explicit trusted browse/search gate. */
  pageByOwner?(subject: string, query: BrowseQuery): Promise<BrowsePage>;
  facetsByOwner?(
    subject: string,
    status?: "active" | "archived" | "all",
  ): Promise<BrowseFacets>;
}

export interface ApiDependencies {
  tasks?: TaskService;
  taskBatches?: TaskExtractionService;
  mcp?: McpOptions;
  oauth?: { db: PrismaClient; clients: OAuthClient[] };
  sessionAuth?: SessionAuth;
  search?: SearchService;
  capture?: {
    persistByOwner(
      owner: string,
      input: CaptureRequest,
    ): Promise<CaptureResponse>;
  };
  research?: {
    persistByOwner(
      owner: string,
      input: ResearchSaveRequest,
    ): Promise<ResearchReceipt>;
    getByOwner(owner: string, reportId: string): Promise<ResearchRecord | null>;
    listByNote(owner: string, noteId: string): Promise<ResearchRecord[] | null>;
    importsByNote?(owner: string, noteId: string): Promise<unknown[]>;
  };
  /** Independent registry: no note source writes, and no GitHub dependency. */
  noteTagEdits?: {
    changeByOwner(
      owner: string,
      id: string,
      edit: NoteTagEditRequest,
    ): Promise<NoteTagEditResponse | null>;
  };
  tagRegistry?: {
    listByOwner(owner: string): Promise<TagRegistryResponse>;
    listObservedStatusesByOwner?(owner: string): Promise<{
      revision: number;
      statuses: Array<{ slug: string; status: "approved" | "candidate" }>;
    }>;
    pageByOwner?(
      owner: string,
      query: TagRegistryQuery,
    ): Promise<TagRegistryResponse>;
    approveByOwner(
      owner: string,
      slug: string,
      input: TagApprovalInput,
    ): Promise<TagApprovalMutationResponse>;
    unapproveByOwner(
      owner: string,
      slug: string,
    ): Promise<TagApprovalMutationResponse>;
    getSnapshotStatus?(owner: string): Promise<{
      desiredRevision: number;
      publishedRevision: number | null;
      publishedAt: string | null;
      stale: boolean;
      state: string;
      lastErrorCode: string | null;
    }>;
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

  // Historical MCP callers already supply OAuth registration in McpOptions.
  // Preserve that contract, but allow a standalone native OAuth registration
  // when MCP tools must remain entirely disabled.
  const registeredOAuth =
    options.dependencies?.oauth ?? options.dependencies?.mcp;
  if (registeredOAuth) {
    if (!sessionAuth) throw new Error("OAuth requires sessions");
    registerOAuth(
      app,
      registeredOAuth.db,
      sessionAuth,
      registeredOAuth.clients,
    );
  }
  if (options.dependencies?.mcp) {
    const { mcp, search, capture } = options.dependencies;
    if (!sessionAuth || !search || !capture)
      throw new Error("MCP requires sessions, search and durable capture");
    registerMcp(
      app,
      mcp,
      sessionAuth,
      search,
      capture,
      options.dependencies.tasks,
      options.dependencies.taskBatches,
    );
  }

  app.decorateRequest("authenticatedPrincipal", null);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");

    const origin = request.headers.origin;
    const allowedOrigins =
      config.corsOrigins ?? (config.corsOrigin ? [config.corsOrigin] : []);
    const allowed = !!origin && allowedOrigins.includes(origin);
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
        ![
          "GET",
          ...(sessionAuth ? ["POST", "PUT", "PATCH", "DELETE"] : []),
        ].includes(String(request.headers["access-control-request-method"]))
      ) {
        return reply.code(403).send(errorResponse("FORBIDDEN"));
      }
      reply.header(
        "Access-Control-Allow-Methods",
        sessionAuth ? "GET, POST, PUT, PATCH, DELETE" : "GET",
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
  if (options.dependencies?.taskBatches) {
    if (!sessionAuth) throw new Error("Task batches require scoped sessions");
    registerTaskBatchRoutes(app, sessionAuth, options.dependencies.taskBatches);
  }
  if (options.dependencies?.tasks) {
    if (!sessionAuth) throw new Error("Tasks require scoped sessions");
    registerTaskRoutes(app, sessionAuth, options.dependencies.tasks);
  }
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

  if (options.dependencies?.research) {
    if (!sessionAuth)
      throw new Error("Research requires scoped session authentication");
    const research = options.dependencies.research;
    app.post(
      "/api/v1/research/reports",
      {
        bodyLimit: 262144,
        preHandler: (request, reply) =>
          requireSessionScope(request, reply, sessionAuth, "capture:write"),
      },
      async (request, reply) => {
        const input = ResearchSaveRequestSchema.safeParse(request.body);
        if (!input.success || Object.keys(request.query as object).length)
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        try {
          return ResearchReceiptSchema.parse(
            await research.persistByOwner(
              request.authenticatedPrincipal!.subject,
              input.data,
            ),
          );
        } catch (error) {
          if (error instanceof Error && error.name === "ResearchConflict")
            return reply.code(409).send(errorResponse("CONFLICT"));
          if (error instanceof TypeError)
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          throw error;
        }
      },
    );
    app.get<{ Params: { id: string } }>(
      "/api/v1/research/reports/:id",
      {
        preHandler: (request, reply) =>
          requireSessionScope(request, reply, sessionAuth, "notes:read"),
      },
      async (request, reply) => {
        if (
          !NoteIdSchema.safeParse(request.params.id).success ||
          Object.keys(request.query as object).length
        )
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        const report = await research.getByOwner(
          request.authenticatedPrincipal!.subject,
          request.params.id,
        );
        return report
          ? ResearchRecordSchema.parse(report)
          : reply.code(404).send(errorResponse("NOT_FOUND"));
      },
    );
    app.get<{ Params: { id: string } }>(
      "/api/v1/notes/:id/research",
      {
        preHandler: (request, reply) =>
          requireSessionScope(request, reply, sessionAuth, "notes:read"),
      },
      async (request, reply) => {
        if (
          !NoteIdSchema.safeParse(request.params.id).success ||
          Object.keys(request.query as object).length
        )
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        const reports = await research.listByNote(
          request.authenticatedPrincipal!.subject,
          request.params.id,
        );
        return reports
          ? ResearchListSchema.parse({
              reports,
              imports:
                (await research.importsByNote?.(
                  request.authenticatedPrincipal!.subject,
                  request.params.id,
                )) ?? [],
            })
          : reply.code(404).send(errorResponse("NOT_FOUND"));
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
        const query = TagRegistryQuerySchema.safeParse(request.query);
        if (!query.success)
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        if (
          Object.keys(request.query as object).length &&
          !registry.pageByOwner
        )
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        const owner = request.authenticatedPrincipal!.subject;
        let catalog;
        try {
          catalog =
            Object.keys(request.query as object).length && registry.pageByOwner
              ? await registry.pageByOwner(owner, query.data)
              : await registry.listByOwner(owner);
        } catch (error) {
          if (error instanceof Error && error.name === "TagCatalogChanged")
            return reply.code(409).send(errorResponse("CONFLICT"));
          throw error;
        }
        const observed = await registry.listObservedStatusesByOwner?.(owner);
        return TagRegistryResponseSchema.parse({
          ...catalog,
          ...(observed?.revision === catalog.revision
            ? { observedStatuses: observed.statuses }
            : {}),
          ...(registry.getSnapshotStatus
            ? { snapshot: await registry.getSnapshotStatus(owner) }
            : {}),
        });
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

  if (options.dependencies?.noteTagEdits) {
    if (!sessionAuth || !notes)
      throw new Error(
        "Note tag editing requires session authentication and DB notes",
      );
    const editor = options.dependencies.noteTagEdits;
    app.patch<{ Params: { id: string } }>(
      "/api/v1/notes/:id/tags",
      {
        preHandler: (request, reply) =>
          requireSessionScope(request, reply, sessionAuth, "tags:write"),
      },
      async (request, reply) => {
        const id = NoteIdSchema.safeParse(request.params.id);
        const edit = NoteTagEditRequestSchema.safeParse(request.body);
        if (
          !id.success ||
          !edit.success ||
          Object.keys(request.query as object).length
        )
          return reply.code(400).send(errorResponse("BAD_REQUEST"));
        try {
          const result = await editor.changeByOwner(
            request.authenticatedPrincipal!.subject,
            id.data,
            edit.data,
          );
          return result
            ? NoteTagEditResponseSchema.parse(result)
            : reply.code(404).send(errorResponse("NOT_FOUND"));
        } catch (error) {
          if (error instanceof Error && error.name === "NoteTagConflictError")
            return reply.code(409).send(errorResponse("CONFLICT"));
          if (error instanceof TypeError)
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          throw error;
        }
      },
    );
  }

  if (notes) {
    const requireNoteScope = async (
      request: FastifyRequest,
      reply: FastifyReply,
      scope: "notes:read" | "notes:write",
    ) => {
      if (sessionAuth)
        return requireSessionScope(request, reply, sessionAuth, scope);
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
      if (!principal.scopes.includes(scope)) {
        return reply.code(403).send(errorResponse("FORBIDDEN"));
      }
      request.authenticatedPrincipal = principal;
    };
    const requireNoteRead = (request: FastifyRequest, reply: FastifyReply) =>
      requireNoteScope(request, reply, "notes:read");
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
          const query = BrowseStatusQuerySchema.safeParse(request.query);
          if (!query.success)
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          const facets =
            query.data.status === undefined
              ? await notes.facetsByOwner!(
                  request.authenticatedPrincipal!.subject,
                )
              : await notes.facetsByOwner!(
                  request.authenticatedPrincipal!.subject,
                  query.data.status,
                );
          return BrowseFacetsSchema.parse(facets);
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
          const query = BrowseStatusQuerySchema.safeParse(request.query);
          if (!query.success) {
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          }
          const tags =
            query.data.status === undefined
              ? await notes.listTagsByOwner!(
                  request.authenticatedPrincipal!.subject,
                )
              : await notes.listTagsByOwner!(
                  request.authenticatedPrincipal!.subject,
                  query.data.status,
                );
          return TagFacetsResponseSchema.parse(tags);
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
    if (notes.removeByOwner) {
      app.delete<{ Params: { id: string } }>(
        "/api/v1/notes/:id",
        {
          preHandler: (request, reply) =>
            requireNoteScope(request, reply, "notes:write"),
        },
        async (request, reply) => {
          const id = NoteIdSchema.safeParse(request.params.id);
          if (
            !id.success ||
            Object.keys(request.query as object).length ||
            request.body !== undefined
          )
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          const removed = await notes.removeByOwner!(
            request.authenticatedPrincipal!.subject,
            id.data,
          );
          if (!removed) return reply.code(404).send(errorResponse("NOT_FOUND"));
          return NoteRemovalResponseSchema.parse({ removed: true });
        },
      );
    }
    if (notes.setArchivedByOwner) {
      app.patch<{ Params: { id: string } }>(
        "/api/v1/notes/:id/archive",
        {
          preHandler: (request, reply) =>
            requireNoteScope(request, reply, "notes:write"),
        },
        async (request, reply) => {
          const id = NoteIdSchema.safeParse(request.params.id);
          const input = NoteArchiveRequestSchema.safeParse(request.body);
          if (
            !id.success ||
            !input.success ||
            Object.keys(request.query as object).length
          )
            return reply.code(400).send(errorResponse("BAD_REQUEST"));
          const status = await notes.setArchivedByOwner!(
            request.authenticatedPrincipal!.subject,
            id.data,
            input.data.archived,
          );
          if (!status) return reply.code(404).send(errorResponse("NOT_FOUND"));
          return NoteArchiveResponseSchema.parse({ status });
        },
      );
    }
  }
  return app;
}
