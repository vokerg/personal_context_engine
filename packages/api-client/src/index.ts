import {
  HealthResponseSchema,
  type HealthResponse,
  ApiErrorResponseSchema,
  NoteDetailSchema,
  NoteIdSchema,
  NotesListResponseSchema,
  type ApiErrorResponse,
  type NoteDetail,
  type NotesListResponse,
} from "@pce/contracts";

/** Explicit URL injection; do not embed backend secrets or presume device localhost. */
export async function getHealth(
  baseUrl: string,
  request: typeof fetch = fetch,
): Promise<HealthResponse> {
  const url = new URL("/health", baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("API URL must be HTTP(S)");
  }
  if (url.username || url.password) {
    throw new TypeError("API URL must not contain credentials");
  }
  const response = await request(url);
  if (!response.ok)
    throw new Error(`API health request failed (${response.status})`);
  return HealthResponseSchema.parse(await response.json());
}

export type AccessTokenProvider = () => string | null | Promise<string | null>;

export interface AuthenticatedRequestOptions {
  baseUrl: string;
  getAccessToken: AccessTokenProvider;
  request?: typeof fetch;
  signal?: AbortSignal;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorResponse["error"]["code"],
  ) {
    super("API request failed (" + status + ")");
    this.name = "ApiRequestError";
  }
}

async function authenticatedGet<T>(
  options: AuthenticatedRequestOptions,
  path: string,
  parse: (data: unknown) => T,
): Promise<T> {
  const url = new URL(path, options.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new TypeError("API URL must be HTTP(S) without credentials");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new TypeError("Authenticated API requests require HTTPS except loopback");
  }
  const token = await options.getAccessToken();
  if (token === null) throw new ApiRequestError(401, "UNAUTHORIZED");
  if (token.length > 4096 || !/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new TypeError("Invalid access token format");
  }
  const response = await (options.request ?? fetch)(url, {
    method: "GET",
    headers: { Authorization: "Bearer " + token },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const parsed = ApiErrorResponseSchema.safeParse(
      (await response.json().catch(() => null)) as unknown,
    );
    const statusCode = response.status;
    const fallback: ApiErrorResponse["error"]["code"] =
      statusCode === 401
        ? "UNAUTHORIZED"
        : statusCode === 403
          ? "FORBIDDEN"
          : statusCode === 404
            ? "NOT_FOUND"
            : statusCode === 503
              ? "SERVICE_UNAVAILABLE"
              : "INTERNAL_ERROR";
    throw new ApiRequestError(
      statusCode,
      parsed.success ? parsed.data.error.code : fallback,
    );
  }
  return parse((await response.json()) as unknown);
}

export function getNotes(
  options: AuthenticatedRequestOptions,
): Promise<NotesListResponse> {
  return authenticatedGet(options, "/api/v1/notes", (data) =>
    NotesListResponseSchema.parse(data),
  );
}

export async function getNote(
  options: AuthenticatedRequestOptions,
  noteId: string,
): Promise<NoteDetail> {
  const id = NoteIdSchema.parse(noteId);
  return authenticatedGet(
    options,
    "/api/v1/notes/" + encodeURIComponent(id),
    (data) => NoteDetailSchema.parse(data),
  );
}
