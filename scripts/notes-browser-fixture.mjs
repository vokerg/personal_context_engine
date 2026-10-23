#!/usr/bin/env node
// Opt-in browser fixture. Explicit disposable DB target; no remote DB/provider calls.
import { randomUUID } from "node:crypto";
import { sessionAllowed } from "./local-runtime.mjs";
import { createServer } from "vite";
import {
  PrismaClient,
  createApiCaptureRepository,
  createTagRegistryRepository,
  createNoteTagRepository,
  createSearchRepository,
} from "@pce/db";
import { createApp } from "../apps/api/dist/app.js";
import { createDatabaseNoteReader } from "../apps/api/dist/database-reader.js";
import { createSessionAuth } from "../apps/api/dist/session-auth.js";
import { createSearchService } from "../apps/api/dist/search.js";
const raw = process.env.PCE_DB_TEST_URL;
if (!raw)
  throw new Error(
    "Set an explicit disposable PCE_DB_TEST_URL; application credentials are never used.",
  );
const target = new URL(raw);
const configuredHost = target.searchParams.get("host");
if (
  !["postgres:", "postgresql:"].includes(target.protocol) ||
  (configuredHost &&
    !configuredHost.startsWith("/") &&
    !["localhost", "127.0.0.1", "::1"].includes(configuredHost))
)
  throw new Error("A loopback or local Unix-socket DB target is required.");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
  !/^pce_test/.test(target.pathname.slice(1))
)
  throw new Error("A loopback disposable pce_test database is required.");
if (process.env.NODE_ENV === "production")
  throw new Error("Synthetic browser fixture is development-only.");
const db = new PrismaClient({ datasources: { db: { url: raw } } }),
  owner = "browser105-" + randomUUID(),
  id = randomUUID(),
  capture = randomUUID();
let api,
  web,
  closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await web?.close();
  await api?.close();
  await db.authSession.deleteMany({ where: { ownerSubject: owner } });
  await db.tagSnapshotOutbox.deleteMany({ where: { ownerSubject: owner } });
  await db.tagApproval.deleteMany({ where: { ownerSubject: owner } });
  await db.tagRegistryRevision.deleteMany({ where: { ownerSubject: owner } });
  await db.apiCaptureReceipt.deleteMany({ where: { ownerSubject: owner } });
  await db.note.deleteMany({ where: { id } });
  await db.capture.deleteMany({ where: { id: capture } });
  await db.$disconnect();
}
try {
  await db.$connect();
  await db.tagApproval.createMany({
    data: Array.from({ length: 205 }, (_, i) => ({
      ownerSubject: owner,
      slug: "synthetic-" + String(i).padStart(3, "0"),
      displayName: i === 204 ? "Hidden comet" : null,
    })),
  });
  await db.tagRegistryRevision.create({
    data: { ownerSubject: owner, revision: 1 },
  });
  await createApiCaptureRepository(db).persistByOwner(owner, {
    idempotencyKey: id,
    notes: [
      `---
schema_version: 1
id: ${id}
capture_id: ${capture}
captured_at: 2026-10-23T10:00:00Z
source: chatgpt_text
kind: memo
domains: []
projects: []
tags: [candidate-paper, synthetic-000]
action_hint: none
review_required: false
title: Synthetic browser acceptance
---

# Synthetic browser acceptance

## Summary

Synthetic fixture only; no private content.

## Original input

Synthetic paper acceptance original.
`,
    ],
  });
  const origin = "http://localhost:4315",
    issuer = "http://localhost:32125";
  const auth = createSessionAuth(db, {
    mode: "dev-single-user",
    ownerSubject: owner,
    origin,
    issuer,
    audience: issuer + "/mcp",
    secure: false,
  });
  api = createApp({
    config: {
      host: "127.0.0.1",
      port: 32125,
      environment: "development",
      corsOrigin: origin,
      requiresDatabase: false,
      auth: null,
    },
    dependencies: {
      sessionAuth: auth,
      capture: createApiCaptureRepository(db),
      notes: createDatabaseNoteReader(db, "c".repeat(32)),
      tagRegistry: createTagRegistryRepository(db),
      noteTagEdits: createNoteTagRepository(db),
      search: createSearchService(createSearchRepository(db), "s".repeat(32)),
    },
  });
  await api.listen({ host: "127.0.0.1", port: 32125 });
  web = await createServer({
    root: new URL("../apps/web", import.meta.url).pathname,
    server: { host: "127.0.0.1", port: 4315, strictPort: true },
    define: {
      "import.meta.env.VITE_PCE_LOCAL_DEV": JSON.stringify("true"),
      "import.meta.env.VITE_PCE_SESSION_AUTH": JSON.stringify("true"),
      "import.meta.env.VITE_PCE_LOCAL_BROWSE": JSON.stringify("true"),
      "import.meta.env.VITE_PCE_DB_SEARCH": JSON.stringify("true"),
      "import.meta.env.VITE_PCE_RESEARCH_REPORTS": JSON.stringify("false"),
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(issuer),
    },
    plugins: [
      {
        name: "synthetic-session",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url !== "/__pce/session") return next();
            if (!sessionAllowed(req, origin)) {
              res.statusCode = 403;
              res.end();
              return;
            }
            try {
              const request = {
                headers: req.headers,
                ip: req.socket.remoteAddress,
              };
              let current = await auth.browserSession(request);
              if (!current) {
                const result = await auth.login(
                  {},
                  { ...request, headers: { ...req.headers, origin } },
                  true,
                );
                res.setHeader("Set-Cookie", result.cookieHeaders);
                current = result.session;
              }
              res.setHeader("Cache-Control", "no-store");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ token: "session-cookie" }));
            } catch {
              res.statusCode = 503;
              res.end();
            }
          });
        },
      },
    ],
  });
  await web.listen();
  console.log(
    "Synthetic-only acceptance app: http://localhost:4315 (205 approvals; separate disposable DB owner). Stop with SIGTERM to clean up.",
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => void close().then(() => process.exit(0)));
} catch {
  await close();
  console.error("Synthetic browser fixture failed; details suppressed.");
  process.exitCode = 1;
}
