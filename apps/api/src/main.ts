import { createApp } from "./app.js";
import { loadApiConfig } from "./config.js";

async function start(): Promise<void> {
  let app: ReturnType<typeof createApp> | undefined;
  try {
    const config = loadApiConfig();
    // DB adapter wiring is deliberately deferred to #8; require DB => fail closed.
    app = createApp({ config });
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
    // Avoid echoing environment values, tokens or connection URLs.
    console.error("API startup failed: invalid configuration or unavailable required dependency");
    if (app) await app.close();
    process.exitCode = 1;
  }
}

await start();
