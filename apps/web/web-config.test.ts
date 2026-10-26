import { describe, expect, it } from "vitest";
import { webConfig } from "./vite.config.js";

describe("web configuration boundary", () => {
  it("preserves Vite's public environment handling in builds and previews", () => {
    const env = {
      PCE_AUTH_MODE: "dev-single-user",
      PCE_WEB_PORT: "invalid",
      VITE_PCE_SESSION_AUTH: "true",
    };
    for (const context of [
      { command: "build" as const, mode: "production" },
      { command: "build" as const, mode: "development" },
      { command: "serve" as const, mode: "production" },
      { command: "serve" as const, mode: "development", isPreview: true },
    ]) {
      const config = webConfig(context, env);
      expect(config.define).toBeUndefined();
      expect(config.server).toBeUndefined();
    }
  });

  it("infers local settings only during development and respects explicit public flags", () => {
    const env = {
      API_PORT: "3110",
      PCE_WEB_PORT: "4310",
      PCE_AUTH_MODE: "dev-single-user",
      PCE_DB_SEARCH: "true",
      PCE_RESEARCH_REPORTS: "true",
      PCE_TASKS_ENABLED: "true",
      SERVER_SECRET: "synthetic-secret",
    };
    const context = { command: "serve" as const, mode: "development" };
    const config = webConfig(context, env);
    expect(config.server).toEqual({
      host: "127.0.0.1",
      port: 4310,
      strictPort: true,
    });
    expect(config.define).toMatchObject({
      "import.meta.env.VITE_API_BASE_URL": '"http://127.0.0.1:3110"',
      "import.meta.env.VITE_PCE_SESSION_AUTH": '"true"',
      "import.meta.env.VITE_PCE_DB_SEARCH": '"true"',
      "import.meta.env.VITE_PCE_LOCAL_BROWSE": '"true"',
      "import.meta.env.VITE_PCE_RESEARCH_REPORTS": '"true"',
      "import.meta.env.VITE_PCE_TASKS": '"true"',
    });
    expect(JSON.stringify(config.define)).not.toContain("synthetic-secret");
    const explicit = webConfig(context, {
      ...env,
      VITE_PCE_SESSION_AUTH: "false",
      VITE_PCE_DB_SEARCH: "false",
      VITE_PCE_LOCAL_BROWSE: "false",
      VITE_PCE_RESEARCH_REPORTS: "false",
      VITE_PCE_TASKS: "false",
    });
    for (const key of [
      "SESSION_AUTH",
      "DB_SEARCH",
      "LOCAL_BROWSE",
      "RESEARCH_REPORTS",
      "TASKS",
    ])
      expect(explicit.define?.[`import.meta.env.VITE_PCE_${key}`]).toBe(
        '"false"',
      );
    expect(() => webConfig(context, { PCE_WEB_PORT: "invalid" })).toThrow();
  });
});
