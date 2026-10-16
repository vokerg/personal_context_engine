#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  localConfig,
  readCaptures,
  createLocalReader,
  mintSession,
  sessionAllowed,
  issuer,
  audience,
} from "./local-runtime.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
let api, web, db;
async function close() {
  await web?.close();
  await api?.close();
  await db?.$disconnect();
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Setup command failed.")),
    );
  });
}
async function portAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied; stop the previous service or choose another port.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
try {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const config = localConfig(process.env);
  await portAvailable(config.apiPort);
  await portAvailable(config.webPort);
  await run(["run", "build"]);
  const { captures, rejectedCount } = await readCaptures(config.contentRoot);
  await run(["run", "db:migrate"]);
  const { createDatabaseClient, createNoteRepository, checkDatabase } =
    await import("@pce/db");
  const { createApp } = await import("../apps/api/dist/app.js");
  const { createServer: createVite } = await import("vite");
  db = createDatabaseClient();
  await db.$connect();
  const repo = createNoteRepository(db);
  const ids = [];
  for (const capture of captures) {
    const result = await repo.importMarkdown(capture);
    ids.push(result.noteId);
  }
  console.log(
    `Local workspace ready: ${ids.length} notes imported or replayed; ${rejectedCount} invalid captures skipped. Content checkout unchanged.`,
  );
  const secret = randomBytes(32).toString("hex");
  api = createApp({
    config: {
      host: "127.0.0.1",
      port: config.apiPort,
      environment: "development",
      corsOrigin: config.origin,
      requiresDatabase: true,
      auth: { issuer, audience, secret },
    },
    dependencies: {
      checkDatabase: () => checkDatabase(db),
      notes: createLocalReader(db, ids),
    },
  });
  web = await createVite({
    root: fileURLToPath(new URL("../apps/web", import.meta.url)),
    server: {
      host: "127.0.0.1",
      port: config.webPort,
      strictPort: true,
      allowedHosts: [],
    },
    define: {
      "import.meta.env.VITE_PCE_LOCAL_DEV": JSON.stringify("true"),
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(
        `http://127.0.0.1:${config.apiPort}`,
      ),
    },
    plugins: [
      {
        name: "pce-local-session",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__pce/session") return next();
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            if (!sessionAllowed(req, config.origin)) {
              res.statusCode = 403;
              res.end();
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ token: mintSession(secret) }));
          });
        },
      },
    ],
  });
  await api.listen({ host: "127.0.0.1", port: config.apiPort });
  await web.listen();
  console.log(
    `Open ${config.origin} — local read-only session connects automatically.`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void close();
    });
} catch (error) {
  // Validation/provider exceptions can contain private content. Print fixed diagnostics only.
  console.error(
    "Local startup failed. Check root .env, free API_PORT/PCE_WEB_PORT, valid content paths and note ownership. No content files were modified.",
  );
  await close();
  process.exitCode = 1;
}
