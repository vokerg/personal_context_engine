import { mcpTransportHost } from "./mcp.js";
import { createDatabaseNoteReader } from "./database-reader.js";
import { oauthClients } from "./oauth.js";
import { randomBytes } from "node:crypto";
import { createSearchRepository } from "@pce/db";
import { createSearchService } from "./search.js";
import { queryEmbeddingProvider } from "./search-provider.js";
import { createSessionAuth, sessionConfig } from "./session-auth.js";
import {
  checkDatabase,
  createDatabaseClient,
  createApiCaptureRepository,
  createTagRegistryRepository,
  createNoteTagRepository,
  createResearchRepository,
} from "@pce/db";
import { createApp } from "./app.js";
import { loadApiConfig, researchReportsEnabled } from "./config.js";

async function start(): Promise<void> {
  let app: ReturnType<typeof createApp> | undefined;
  let db: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    const config = loadApiConfig();
    const enableResearchReports = researchReportsEnabled(process.env);
    if (config.requiresDatabase) {
      // Never start an API with mandatory DB configuration without a live DB.
      db = createDatabaseClient();
      await db.$connect();
    }
    const connected = db;
    const clients = oauthClients(process.env);
    const transportHost = mcpTransportHost(process.env);
    if (clients.length && (!connected || process.env.PCE_DB_SEARCH !== "true"))
      throw new Error("MCP requires database search");
    const sessionOptions = sessionConfig(process.env);
    if (
      process.env.PCE_DB_SEARCH &&
      !["true", "false"].includes(process.env.PCE_DB_SEARCH)
    )
      throw new Error("Invalid search flag");
    if (process.env.PCE_DB_SEARCH === "true" && !sessionOptions)
      throw new Error("Search requires configured sessions");
    if (sessionOptions && !connected)
      throw new Error("Sessions require a database");
    if (enableResearchReports && (!sessionOptions || !connected))
      throw new Error("Research reports require configured database sessions");
    app = createApp({
      config: {
        ...config,
        corsOrigin: sessionOptions?.origin ?? config.corsOrigin,
      },
      ...(connected
        ? {
            dependencies: {
              checkDatabase: () => checkDatabase(connected),
              ...(clients.length
                ? {
                    mcp: {
                      db: connected,
                      clients,
                      ...(transportHost ? { transportHost } : {}),
                    },
                  }
                : {}),
              ...(sessionOptions
                ? {
                    sessionAuth: createSessionAuth(connected, sessionOptions),
                    capture: createApiCaptureRepository(connected),
                    ...(enableResearchReports
                      ? { research: createResearchRepository(connected) }
                      : {}),
                    tagRegistry: createTagRegistryRepository(connected),
                    ...(process.env.PCE_DB_SEARCH === "true"
                      ? {
                          noteTagEdits: createNoteTagRepository(connected),
                          notes: createDatabaseNoteReader(
                            connected,
                            randomBytes(32).toString("hex"),
                          ),
                          search: createSearchService(
                            createSearchRepository(
                              connected,
                              enableResearchReports,
                            ),
                            randomBytes(32).toString("hex"),
                            queryEmbeddingProvider(process.env),
                            undefined,
                            process.env.PCE_SEARCH_DIAGNOSTICS === "true",
                          ),
                        }
                      : {}),
                  }
                : {}),
            },
          }
        : {}),
    });
    if (connected) {
      app.addHook("onClose", async () => {
        await connected.$disconnect();
      });
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void app!.close().catch(() => {
          process.exitCode = 1;
        });
      });
    }
    await app.listen({ host: config.host, port: config.port });
    console.log("Public API listening on configured bind address");
  } catch {
    // Never echo DB URLs, credentials, query errors, or note contents.
    console.error(
      "API startup failed: invalid configuration or unavailable required dependency",
    );
    if (app) await app.close();
    else if (db) await db.$disconnect();
    process.exitCode = 1;
  }
}

await start();
