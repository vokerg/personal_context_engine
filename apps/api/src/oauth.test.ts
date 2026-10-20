import { describe, expect, it } from "vitest";
import { mcpTransportHost } from "./mcp.js";
import { oauthClients } from "./oauth.js";
import { sessionConfig } from "./session-auth.js";
describe("trusted MCP deployment configuration", () => {
  it("keeps MCP off by default and rejects unsafe or ambiguous client callbacks", () => {
    expect(oauthClients({})).toEqual([]);
    const client = {
      clientId: "test-client",
      scopes: ["notes:read"],
      redirectUris: ["https://client.example/callback"],
    };
    const env = (clients: unknown) => ({
      PCE_MCP_ENABLED: "true",
      PCE_OAUTH_CLIENTS: JSON.stringify(clients),
    });
    expect(oauthClients(env([client]))).toEqual([client]);
    for (const uri of [
      "http://client.example/callback",
      "https://user:password@client.example/callback",
      "https://client.example/callback#fragment",
      "https://client.example/callback?code=shadow",
      "https://client.example/callback?iss=shadow",
    ])
      expect(() =>
        oauthClients(env([{ ...client, redirectUris: [uri] }])),
      ).toThrow();
    expect(() => oauthClients(env([client, client]))).toThrow();
    expect(() => oauthClients(env([]))).toThrow();
  });
  it("pins only an explicit secure transport origin", () => {
    expect(mcpTransportHost({})).toBeUndefined();
    expect(
      mcpTransportHost({ PCE_MCP_TRANSPORT_ORIGIN: "https://backend.example" }),
    ).toBe("backend.example");
    expect(
      mcpTransportHost({ PCE_MCP_TRANSPORT_ORIGIN: "http://127.0.0.1:3110" }),
    ).toBe("127.0.0.1:3110");
    for (const value of [
      "http://backend.example",
      "https://backend.example/path",
      "https://user:secret@backend.example",
      "https://backend.example?host=other",
      "https://backend.example#fragment",
      "backend.example",
    ]) {
      expect(() =>
        mcpTransportHost({ PCE_MCP_TRANSPORT_ORIGIN: value }),
      ).toThrow();
    }
  });
  it("requires the same host for browser and API session cookies", () => {
    expect(() =>
      sessionConfig({
        PCE_AUTH_MODE: "dev-single-user",
        PCE_WEB_ORIGIN: "http://localhost:4312",
        PCE_API_ORIGIN: "http://127.0.0.1:3112",
      }),
    ).toThrow("one hostname");
    expect(
      sessionConfig({
        PCE_AUTH_MODE: "dev-single-user",
        PCE_WEB_ORIGIN: "http://127.0.0.1:4312",
        PCE_API_ORIGIN: "http://127.0.0.1:3112",
      }),
    ).toMatchObject({ mode: "dev-single-user" });
  });
});
