import { checkDatabase, createDatabaseClient } from "@pce/db";
import { createApp } from "./app.js";
import { loadApiConfig } from "./config.js";

async function start(): Promise<void> {
  let app: ReturnType<typeof createApp> | undefined;
  let db: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    const config = loadApiConfig();
    if (config.requiresDatabase) {
      // Never start an API with mandatory DB configuration without a live DB.
      db = createDatabaseClient();
      await db.$connect();
    }
    const connected = db;
    app = createApp({
      config,
      ...(connected
        ? { dependencies: { checkDatabase: () => checkDatabase(connected) } }
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
