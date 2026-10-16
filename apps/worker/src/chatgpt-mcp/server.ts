import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  buildChatContextNote,
  CaptureInputError,
  type ChatContextInput,
} from "./capture.js";
import {
  ChatContextStorageError,
  GitHubChatContextWriter,
} from "./github-writer.js";
import {
  makeOAuthVerifier,
  oauthConfigFromEnv,
  type OAuthConfig,
} from "./oauth.js";

const MCP_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 750_000;
type JsonRecord = Record<string, unknown>;
type Writer = Pick<GitHubChatContextWriter, "save">;

const captureTool = {
  name: "save_chat_context",
  title: "Save conversation context to Personal Context Engine",
  description:
    "Save current user-selected chat context to the private PCE inbox. Use only at the user's explicit request. brief: faithful summary and exact selected excerpt, NOT full history. full: complete transcript must actually be available and explicitly confirmed as complete by the user. Cannot fetch other ChatGPT conversations. Never infer/claim access to hidden messages. Show the user what will be saved before calling this write tool.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      request_id: {
        type: "string",
        description:
          "One fresh UUID per save; reuse the exact same UUID for a retry.",
      },
      mode: { type: "string", enum: ["brief", "full"] },
      title: { type: "string", minLength: 1, maxLength: 200 },
      summary: {
        type: "string",
        minLength: 1,
        description: "Faithful, non-invented summary in the user's language.",
      },
      source_text: {
        type: "string",
        minLength: 1,
        description:
          "Verbatim selected text (brief) or the actual complete transcript (full); no invented messages.",
      },
      full_transcript_confirmed: {
        type: "boolean",
        description:
          "Only true if the user explicitly confirmed the supplied source_text is the complete conversation transcript.",
      },
    },
    required: ["request_id", "mode", "title", "summary", "source_text"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  securitySchemes: [{ type: "oauth2", scopes: ["pce.capture"] }],
} as const;

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}
async function parseRequest(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new Error("TYPE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("SIZE");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
function rpc(id: unknown, result: unknown): JsonRecord {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string): JsonRecord {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
const toolError = (message: string): JsonRecord => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/** MCP Streamable HTTP (stateless JSON response subset); no cookies or sessions. */
export function createMcpHandler(options: {
  writer: Writer;
  authorize: (token: string | undefined) => Promise<boolean>;
  oauth: OAuthConfig;
  now?: () => Date;
}) {
  const { writer, authorize, oauth } = options;
  const resourceMetadata = new URL(
    "/.well-known/oauth-protected-resource",
    oauth.resourceUrl,
  ).toString();
  const challenge =
    'Bearer resource_metadata="' +
    resourceMetadata +
    '", error="insufficient_scope", error_description="OAuth login with pce.capture required"';
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (
      req.method === "GET" &&
      (pathname === "/.well-known/oauth-protected-resource" ||
        pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      send(res, 200, {
        resource: oauth.resourceUrl,
        authorization_servers: [oauth.issuer],
        scopes_supported: ["pce.capture"],
        bearer_methods_supported: ["header"],
      });
      return;
    }
    if (req.method === "GET" && pathname === "/health") {
      send(res, 200, { status: "ok" });
      return;
    }
    if (pathname !== "/mcp" || req.method !== "POST") {
      send(
        res,
        pathname === "/mcp" ? 405 : 404,
        { error: "not_found" },
        pathname === "/mcp" ? { Allow: "POST" } : {},
      );
      return;
    }
    let message: unknown;
    try {
      message = await parseRequest(req);
    } catch {
      send(
        res,
        400,
        rpcError(null, -32700, "Invalid or oversized JSON request"),
      );
      return;
    }
    if (
      !isObject(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    ) {
      send(res, 400, rpcError(null, -32600, "Invalid JSON-RPC request"));
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      // MCP notifications do not receive a JSON-RPC response.
      res.writeHead(202, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const id = message.id;
    if (!(typeof id === "number" || typeof id === "string")) {
      send(res, 400, rpcError(null, -32600, "Invalid request ID"));
      return;
    }
    if (message.method === "initialize") {
      send(
        res,
        200,
        rpc(id, {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "personal-context-engine", version: "0.1.0" },
          instructions:
            "Save only explicitly user-selected context. Brief requires a verbatim excerpt; full requires an actual user-confirmed complete transcript. No automatic access to old chats. Persist only after explicit user consent.",
        }),
      );
    } else if (message.method === "ping") {
      send(res, 200, rpc(id, {}));
    } else if (message.method === "tools/list") {
      send(res, 200, rpc(id, { tools: [captureTool] }));
    } else if (message.method === "tools/call") {
      const params = message.params;
      if (
        !isObject(params) ||
        params.name !== captureTool.name ||
        !isObject(params.arguments)
      ) {
        send(res, 200, rpcError(id, -32602, "Invalid tool parameters"));
        return;
      }
      const authenticated = await authorize(req.headers.authorization);
      if (!authenticated) {
        send(
          res,
          200,
          rpc(id, {
            ...toolError(
              "Authentication required to save conversation context.",
            ),
            _meta: { "mcp/www_authenticate": [challenge] },
          }),
          { "WWW-Authenticate": challenge },
        );
        return;
      }
      try {
        const capturedAt = (options.now ?? (() => new Date()))().toISOString();
        const artifact = buildChatContextNote(params.arguments, capturedAt);
        const result = await writer.save(
          params.arguments as unknown as ChatContextInput,
          artifact.note,
          artifact.path,
          artifact.markdown,
        );
        send(
          res,
          200,
          rpc(id, {
            content: [
              {
                type: "text",
                text:
                  "Context " +
                  result.status +
                  " in private inbox as " +
                  result.noteId +
                  ".",
              },
            ],
            structuredContent: result,
            isError: false,
          }),
        );
      } catch (error) {
        const code =
          error instanceof CaptureInputError
            ? error.code
            : error instanceof ChatContextStorageError
              ? error.code
              : "FAILED";
        send(
          res,
          200,
          rpc(
            id,
            toolError(
              "Context NOT saved: " +
                code +
                ". Review your input or configuration.",
            ),
          ),
        );
      }
    } else {
      send(res, 200, rpcError(id, -32601, "Method not found"));
    }
  };
}

export function startChatGptMcpServer(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof createServer> {
  const oauth = oauthConfigFromEnv(env);
  const port = Number(env.PCE_MCP_PORT ?? "8787");
  const host = env.PCE_MCP_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid MCP port");
  // TLS terminates at a trusted reverse proxy; no direct public HTTP bind.
  if (host !== "127.0.0.1" && host !== "::1")
    throw new Error("MCP must bind loopback behind HTTPS proxy");
  const repository = env.CONTENT_REPOSITORY;
  const branch = env.CONTENT_BRANCH;
  const token = env.CONTENT_GITHUB_TOKEN;
  if (!repository || !branch || !token)
    throw new Error("Missing private content GitHub configuration");
  const writer = new GitHubChatContextWriter({ repository, branch, token });
  const handler = createMcpHandler({
    writer,
    authorize: makeOAuthVerifier(oauth),
    oauth,
  });
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent)
        send(response, 500, { error: "internal_error" });
      else response.end();
    });
  });
  server.listen(port, host, () =>
    console.log("PCE ChatGPT MCP listening on loopback"),
  );
  return server;
}
