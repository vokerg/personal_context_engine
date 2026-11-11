import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@pce/db";
import type { SessionAuth } from "./session-auth.js";
import type { SearchService } from "./search.js";
import { registerMcp } from "./mcp.js";

describe("content-free MCP capture failures", () => {
  it.each([
    ["NoteValidationError", "BAD_REQUEST"],
    ["TypeError", "BAD_REQUEST"],
    ["CaptureConflict", "CONFLICT"],
    ["Error", "UNAVAILABLE"],
  ])(
    "classifies %s without exposing source or exception text",
    async (name, code) => {
      const app = Fastify({ logger: false });
      const error =
        name === "TypeError"
          ? new TypeError("private payload")
          : new Error("private payload");
      error.name = name;
      const persist = vi.fn().mockRejectedValue(error);
      registerMcp(
        app,
        { db: {} as PrismaClient, clients: [] },
        {
          config: { issuer: "http://localhost", origin: "http://localhost" },
          verifyAccessToken: async () => ({
            subject: "verified-owner",
            scopes: ["notes:read", "capture:write"],
          }),
        } as unknown as SessionAuth,
        {} as SearchService,
        {
          persistByOwner: persist,
          persistTextByOwner: persist,
        },
      );
      try {
        const reply = await app.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            host: "localhost",
            authorization: "Bearer " + "a".repeat(64),
            accept: "application/json, text/event-stream",
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "capture_note",
              arguments: {
                idempotencyKey: "fixture",
                text: "Synthetic source",
              },
            },
          },
        });
        expect(reply.statusCode).toBe(200);
        expect(JSON.parse(reply.json().result.content[0].text)).toEqual({
          error: code,
        });
        expect(reply.json().result.isError).toBe(true);
        expect(reply.body).not.toContain("private payload");
        expect(reply.body).not.toContain("Synthetic source");
        expect(persist).toHaveBeenCalledWith("verified-owner", {
          idempotencyKey: "fixture",
          text: "Synthetic source",
        });
      } finally {
        await app.close();
      }
    },
  );
});
