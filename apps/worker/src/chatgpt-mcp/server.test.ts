import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "./server.js";
import type { OAuthConfig } from "./oauth.js";

const oauth: OAuthConfig = {
  issuer: "https://auth.synthetic.test",
  jwksUrl: "https://auth.synthetic.test/keys",
  audience: "https://capture.synthetic.test/mcp",
  ownerSub: "test-owner",
  resourceUrl: "https://capture.synthetic.test/mcp",
};
const args = {
  request_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  mode: "brief",
  title: "Synthetic context",
  summary: "An imaginary implementation was discussed.",
  source_text: "Let's add a pretend feature.",
};
const call = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function start(authorized = false) {
  const save = vi.fn(async () => ({
    status: "created" as const,
    path: "inbox/synthetic.md",
    noteId: "synthetic",
  }));
  const handler = createMcpHandler({
    writer: { save },
    authorize: async (authorization) =>
      authorized && authorization === "Bearer synthetic",
    oauth,
    now: () => new Date("2026-10-16T19:40:00.000Z"),
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  const base = "http://127.0.0.1:" + address.port;
  const post = (data: unknown, authorization?: string) =>
    fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(data),
    });
  return { base, post, save };
}

describe("ChatGPT stateless MCP transport", () => {
  it("advertises tools and OAuth metadata without requiring private access", async () => {
    const { base, post } = await start();
    const metadata = await (
      await fetch(base + "/.well-known/oauth-protected-resource")
    ).json();
    expect(metadata.authorization_servers).toEqual([oauth.issuer]);
    expect(metadata.resource).toBe(oauth.resourceUrl);
    const init = await (await post(call(1, "initialize"))).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const tools = await (await post(call(2, "tools/list"))).json();
    expect(tools.result.tools[0].name).toBe("save_chat_context");
    expect(tools.result.tools[0].securitySchemes[0].scopes).toEqual([
      "pce.capture",
    ]);
  });

  it("blocks writes unless the owner token verifies; emits the linking challenge", async () => {
    const { post, save } = await start();
    const response = await (
      await post(
        call(4, "tools/call", { name: "save_chat_context", arguments: args }),
      )
    ).json();
    expect(response.result.isError).toBe(true);
    expect(response.result._meta["mcp/www_authenticate"][0]).toContain(
      "oauth-protected-resource",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects an unconfirmed full transcript without writing", async () => {
    const { post, save } = await start(true);
    const response = await (
      await post(
        call(5, "tools/call", {
          name: "save_chat_context",
          arguments: { ...args, mode: "full" },
        }),
        "Bearer synthetic",
      )
    ).json();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain(
      "TRANSCRIPT_NOT_CONFIRMED",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("persists a validated brief after OAuth authorization and returns no note content", async () => {
    const { post, save } = await start(true);
    const result = await (
      await post(
        call(6, "tools/call", {
          name: "save_chat_context",
          arguments: args,
        }),
        "Bearer synthetic",
      )
    ).json();
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent.status).toBe("created");
    expect(JSON.stringify(result)).not.toContain(args.source_text);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![1].metadata.tags).toContain("brief");
  });

  it("rejects invalid method and body safely", async () => {
    const { post } = await start();
    const bad = await (await post(call(7, "unrecognized"))).json();
    expect(bad.error.code).toBe(-32601);
    const missing = await post({ jsonrpc: "2.0", id: 8 });
    expect(missing.status).toBe(400);
  });
});
