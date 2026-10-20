#!/usr/bin/env node
import { startLocalIngestion } from "./local-ingestion.mjs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  localConfig,
  createLocalReader,
  mintSession,
  sessionAllowed,
  issuer,
  audience,
} from "./local-runtime.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
let api, web, db, ingestion;
async function close() {
  await ingestion?.close();
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
  await run(["run", "db:migrate"]);
  const { createDatabaseClient, checkDatabase } = await import("@pce/db");
  const { createSessionAuth, sessionConfig } = await import("../apps/api/dist/session-auth.js");
  const sessionOptions = sessionConfig({...process.env,PCE_WEB_ORIGIN:config.origin,PCE_API_ORIGIN:`http://127.0.0.1:${config.apiPort}`});
  const { createApp } = await import("../apps/api/dist/app.js");
  const { createServer: createVite } = await import("vite");
  db = createDatabaseClient();
  await db.$connect();
  const sessionAuth = sessionOptions ? createSessionAuth(db,sessionOptions) : undefined;
  const ids = [];
  ingestion = startLocalIngestion({
    db,
    contentRoot: config.contentRoot,
    ids,
    env: process.env,
  });
  await ingestion.refresh();
  if (ingestion.status.error) throw new Error("Initial ingestion failed");
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
      ...(sessionAuth ? {sessionAuth} : {}),
      checkDatabase: () => checkDatabase(db),
      notes: createLocalReader(db, ids, {
        browseEnabled: config.browseEnabled,
        cursorSecret: randomBytes(32).toString("hex"),
      }),
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
      "import.meta.env.VITE_PCE_SESSION_AUTH": JSON.stringify(String(!!sessionAuth)),
      "import.meta.env.VITE_PCE_LOCAL_DEV": JSON.stringify("true"),
      "import.meta.env.VITE_PCE_LOCAL_BROWSE": JSON.stringify(
        String(config.browseEnabled),
      ),
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(
        `http://127.0.0.1:${config.apiPort}`,
      ),
    },
    plugins: [
      {
        name: "pce-local-session",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!["/__pce/session", "/__pce/ingestion"].includes(req.url))
              return next();
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            if (!sessionAllowed(req, config.origin)) {
              res.statusCode = 403;
              res.end();
              return;
            }
            res.setHeader("Content-Type", "application/json");
            if (sessionAuth && req.url === "/__pce/session") {
              try {
                const request = {headers:req.headers,ip:req.socket.remoteAddress};
                let current = await sessionAuth.browserSession(request);
                if (!current && sessionOptions.mode === "dev-single-user") {
                  const result = await sessionAuth.login({}, { ...request, headers:{...req.headers,origin:config.origin} }, true);
                  res.setHeader("Set-Cookie",result.cookieHeaders); current=result.session;
                }
                if(!current){res.statusCode=401;res.end();return;}
                res.end(JSON.stringify({token:"session-cookie"}));
              } catch {res.statusCode=503;res.end();}
              return;
            }

            res.end(
              JSON.stringify(
                req.url === "/__pce/ingestion"
                  ? ingestion.status
                  : { token: mintSession(secret) },
              ),
            );
          });
        },
      },
    ],
  });
  await api.listen({ host: "127.0.0.1", port: config.apiPort });
  await web.listen();
  ingestion.start();
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
    "Local startup failed. Check root .env, free API_PORT/PCE_WEB_PORT, valid content paths and note ownership.",
  );
  await close();
  process.exitCode = 1;
}
