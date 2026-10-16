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
  /** Opt-in per-request timeout (100–60000ms). */
  timeoutMs?: number;
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

export type ApiTransportErrorCode =
  "NETWORK_ERROR" | "TIMEOUT" | "CANCELLED" | "INVALID_RESPONSE";

export class ApiTransportError extends Error {
  constructor(readonly code: ApiTransportErrorCode) {
    super("API transport failed (" + code + ")");
    this.name = "ApiTransportError";
  }
}

/** No server message, token or note data is ever copied into a UI error. */
export function describeNotesError(error: unknown, detail = false): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401)
      return "Session expired or invalid. Enter a new access token.";
    if (error.status === 403)
      return "This session is missing notes:read access.";
    if (error.status === 404)
      return detail
        ? "This note is unavailable."
        : "Private note reads are not enabled on this API.";
    if (error.status === 503) return "The API is temporarily unavailable.";
    return "The API could not complete this request.";
  }
  if (error instanceof ApiTransportError) {
    if (error.code === "TIMEOUT") return "The request timed out. Try again.";
    if (error.code === "CANCELLED") return "The request was cancelled.";
    if (error.code === "INVALID_RESPONSE")
      return "The API returned an unexpected response.";
    return "Could not reach the API. Check the address and connection.";
  }
  return "Unable to load notes. Check the API configuration.";
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
    throw new TypeError(
      "Authenticated API requests require HTTPS except loopback",
    );
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 60000)
  ) {
    throw new TypeError("API timeout must be 100–60000ms");
  }

  const controller =
    options.timeoutMs === undefined ? null : new AbortController();
  const forwardAbort = () => controller?.abort();
  if (controller && options.signal) {
    options.signal.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal.aborted) controller.abort();
  }
  const signal = controller?.signal ?? options.signal;
  let timedOut = false;
  const timer =
    controller && options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs)
      : undefined;

  try {
    if (signal?.aborted) throw new ApiTransportError("CANCELLED");
    const token = signal
      ? await new Promise<string | null>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error("Request aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
            return;
          }
          Promise.resolve()
            .then(() => options.getAccessToken())
            .then(
              (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
              },
              (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
        })
      : await options.getAccessToken();
    // Async session providers must not authorize an already-cancelled request.
    if (signal?.aborted)
      throw new ApiTransportError(timedOut ? "TIMEOUT" : "CANCELLED");
    if (token === null) throw new ApiRequestError(401, "UNAUTHORIZED");
    if (token.length > 4096 || !/^[A-Za-z0-9._-]+$/.test(token)) {
      throw new TypeError("Invalid access token format");
    }
    const response = await (options.request ?? fetch)(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + token },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(
        (await response.json().catch(() => null)) as unknown,
      );
      const fallback: ApiErrorResponse["error"]["code"] =
        response.status === 401
          ? "UNAUTHORIZED"
          : response.status === 403
            ? "FORBIDDEN"
            : response.status === 404
              ? "NOT_FOUND"
              : response.status === 503
                ? "SERVICE_UNAVAILABLE"
                : "INTERNAL_ERROR";
      throw new ApiRequestError(
        response.status,
        parsed.success ? parsed.data.error.code : fallback,
      );
    }
    try {
      return parse((await response.json()) as unknown);
    } catch {
      if (signal?.aborted)
        throw new ApiTransportError(timedOut ? "TIMEOUT" : "CANCELLED");
      throw new ApiTransportError("INVALID_RESPONSE");
    }
  } catch (error) {
    if (
      error instanceof ApiRequestError ||
      error instanceof ApiTransportError ||
      (error instanceof TypeError &&
        error.message === "Invalid access token format")
    ) {
      throw error;
    }
    if (signal?.aborted)
      throw new ApiTransportError(timedOut ? "TIMEOUT" : "CANCELLED");
    throw new ApiTransportError("NETWORK_ERROR");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (controller && options.signal)
      options.signal.removeEventListener("abort", forwardAbort);
  }
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

export type { NotePreview, NoteDetail } from "@pce/contracts";

/** Validate a navigation ID using the same contract as the API. */
export function isNoteId(value: string): boolean {
  return NoteIdSchema.safeParse(value).success;
}
