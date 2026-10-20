import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./config.js";

describe("API environment validation", () => {
  it("defaults to loopback with no mandatory dependencies or CORS", () => {
    expect(loadApiConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      environment: "development",
      corsOrigin: null,
      requiresDatabase: false,
      auth: null,
    });
  });

  it("uses the hosting platform port unless API_PORT explicitly overrides it", () => {
    expect(loadApiConfig({ PORT: "10000" }).port).toBe(10000);
    expect(loadApiConfig({ PORT: "10000", API_PORT: "3110" }).port).toBe(3110);
    expect(() => loadApiConfig({ PORT: "invalid" })).toThrow();
  });

  it("rejects non-port, dangerous origin and inconsistent environment values", () => {
    for (const env of [
      { API_PORT: "NaN" },
      { API_PORT: "0" },
      { API_PORT: "65536" },
      { API_PORT: "30.0" },
      { API_HOST: "example.com" },
      { NODE_ENV: "unknown" },
      { API_REQUIRE_DB: "yes" },
      { DATABASE_URL: " " },
      { API_CORS_ORIGIN: "*" },
      { API_CORS_ORIGIN: "http://user:password@localhost:4200" },
      { API_CORS_ORIGIN: "https://example.com/path" },
      { API_CORS_ORIGIN: "https://example.com/" },
      { API_CORS_ORIGIN: "http://example.com", NODE_ENV: "production" },
      { NODE_ENV: "production" },
      { API_AUTH_ISSUER: "issuer" },
      {
        API_AUTH_ISSUER: "issuer",
        API_AUTH_AUDIENCE: "api",
        API_AUTH_HS256_SECRET: "short",
      },
    ]) {
      expect(() => loadApiConfig(env)).toThrow();
    }
  });

  it("requires dependency checks when a DB URL is configured, even if flag false", () => {
    const config = loadApiConfig({
      DATABASE_URL: "postgresql://synthetic.example/test",
      API_REQUIRE_DB: "false",
      NODE_ENV: "production",
      API_AUTH_ISSUER: "example-issuer",
      API_AUTH_AUDIENCE: "example-api",
      API_AUTH_HS256_SECRET: "synthetic-key-32-bytes-minimum-secure----",
      API_CORS_ORIGIN: "https://app.example",
    });
    expect(config.requiresDatabase).toBe(true);
    expect(config.corsOrigin).toBe("https://app.example");
    expect(config.auth?.audience).toBe("example-api");
  });
});
