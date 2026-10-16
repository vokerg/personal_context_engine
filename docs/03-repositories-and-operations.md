# 03 — Repositories, development and operations

## Repositories

### Public mechanism: `vokerg/personal_context_engine`

Purpose: code, test fixtures (synthetic only), canonical contract specifications, API, React web, Expo mobile, worker, workflows and reusable open-source configuration. GitHub Actions and PR reviews belong here.

### Private content: `vokerg/personal_context_engine_content`

Purpose: personal input files, accepted notes, ledgers and narrow ChatGPT capture guidance. **No application CI** and no application source code. The owner plans to make this repository private; until its actual visibility is changed, **never write personal content to it**.

Proposed content layout (created separately when ready):

```text
AGENTS.md                   # content-specific instructions, not app code guidance
inbox/                      # new, not yet finalized Markdown
notes/YYYY/MM/              # successfully imported canonical Markdown
ledgers/daily/
ledgers/weekly/
ledgers/monthly/
ledgers/projects/
rejected/                   # invalid input, preserved for repair
```

Git does not preserve truly empty directories; a bootstrap can include a README or a non-sensitive placeholder. No content repository CI, workflows or shared PR secret exposure.

## Public monorepo layout (scaffold implemented)

```text
apps/
  api/                       # Fastify, auth, HTTP handlers, services
  worker/                    # ingestion, reconciliation, aggregation, reminders
  web/                       # React, TypeScript, Vite
  mobile/                    # React Native + Expo
packages/
  core/                      # pure domain and validation rules
  contracts/                 # Zod HTTP schemas and DTOs
  api-client/                # shared typed API client
docs/                        # architecture baseline
scripts/                     # maintenance and verification
.github/workflows/           # public, synthetic-only CI
AGENTS.md
README.md
package.json                 # npm workspaces and root commands
package-lock.json            # committed npm dependency resolution
```

Favor a modular monolith and independent process entry points over multiple deployable microservices. Share types, hooks or client logic only when actually portable; keep React DOM and React Native presentation separate.

## Local development target

The bootstrapped workspaces require Node.js 22.12+ and npm 10+. The root lockfile enables reproducible clean installation. Commands are:

```bash
nvm use
npm ci
npm run lint
npm run typecheck
npm test                 # builds workspaces and exercises synthetic smoke tests
npm run build
npm run docs:check
npm run dev              # API :3000, default-idle worker and Vite web :4200
npm run dev:mobile       # separate Expo/Metro dev session
```

The API binds to `127.0.0.1:3000` by default; `API_HOST` and `API_PORT` are validated at startup. Public `GET /health`, `GET /ready` and `GET /api/v1` are implemented. Private note routes are registered only if an authenticated, owner-scoped note reader is explicitly injected (#13); default startup still exposes only public endpoints. The DB projection package lacks persisted ownership and is not wired to private reads. The default worker starts/stops without ingesting data; issue #10 adds an explicit once-mode worker that requires a database and an opted-in ContentStore. React web is a static scaffold and the Expo app is a native scaffold; neither reads private content. Running Expo on a real device needs local Expo tooling, a compatible emulator/device, and separate device-reachable API configuration when auth arrives. CI does **not** claim native simulator validation. `db:migrate` applies the checked-in Prisma/PostgreSQL projection migration (issue #8); see [DB setup](../packages/db/README.md).

## Environment and credentials

Server-side configuration (only non-secret API settings are implemented by #9; other adapters are future work):

```dotenv
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...
CONTENT_REPOSITORY=vokerg/personal_context_engine_content
CONTENT_BRANCH=main
CONTENT_STORE_PROVIDER=github
CONTENT_GITHUB_TOKEN=...
API_REQUIRE_DB=false
API_CORS_ORIGIN=http://127.0.0.1:4200
API_AUTH_MODE=...
LLM_PROVIDER=disabled
PUSH_PROVIDER=disabled
```

- `API_HOST`, `API_PORT`, `API_REQUIRE_DB`, optional single-origin `API_CORS_ORIGIN`, and scoped bearer authentication configuration are implemented. CORS is denied by default; production non-loopback origins require HTTPS. `DATABASE_URL` or `API_REQUIRE_DB=true` makes the database mandatory; startup requires a live PostgreSQL connection and `/ready` uses a trusted DB probe (#8). `/health` does not imply database readiness.
- Other secret names and exact provisioning methods remain implementation proposals.
- Tokens must be scoped to necessary repository paths/operations where possible; do not commit values.
- Runtime content credentials belong to deployed API/worker secret storage, **not public CI** and **never clients**.
- Backend must fail safely when a provider is unavailable; do not silently invoke paid LLM APIs.

## Git and CI policy

- Follow the [issue-first contribution process](../CONTRIBUTING.md): a well-scoped issue precedes each non-trivial code, schema, infrastructure or architecture change; use one short-lived branch and reviewable PR per issue. Do not push normal changes directly to `main`. A coding agent must not approve its own PR or merge without explicit human authorization for that PR. Prefer squash merge.
- Protect `main` as soon as workflows and branch rules are ready.
- Public CI may lint docs, typecheck/build, run unit and integration tests with synthetic fixtures, and audit dependencies.
- Public PR workflows must use minimal `GITHUB_TOKEN` permissions and **no** content repository secret, personal dumps or external action tokens.
- Separate path-based data changes from code pipelines: the private content repo must not trigger public build/test/deploy workflows.
- Production jobs may be separately deployed from this code repository, but their private content access is provisioned in a trusted runtime environment only.
- A failing content ingestion is handled by runtime status and retries, not by committing an error log to the public repo.

## Deployment decisions still open

Select hosting, database provider, user authentication, push infrastructure, scheduler, secure webhook delivery and backup/restore tooling during implementation. Document real costs and limits before promising "free" server-side LLM processing. GitHub storage and LLM providers are adapters, not product requirements.

## Operational recovery

Backup the database (including state and device registrations with appropriate protection) and the content repo independently. Test reimport from Markdown, replay after a worker crash, reconciliation of incomplete Git moves, and safe schema migrations. Remember Git history may retain supposedly deleted content; repository privacy is not an erasure policy.

### API public endpoints and dependency failure behavior (#9)

No private read endpoints are available. Run `npm run dev:api` and check:

```bash
curl -i http://127.0.0.1:3000/health  # 200 {"status":"ok"}
curl -i http://127.0.0.1:3000/ready   # 200 {"status":"ready"} with no mandatory dependencies
curl -i http://127.0.0.1:3000/api/v1  # 200 {"version":"v1"}
curl -i http://127.0.0.1:3000/api/v1/notes # 404 {"error":{"code":"NOT_FOUND"}}
API_PORT=not-a-port node apps/api/dist/main.js   # nonzero exit
API_REQUIRE_DB=true node apps/api/dist/main.js   # nonzero exit without a configured, reachable DB
```

The `createApp` dependency interface accepts an injected `checkDatabase` probe
for tests and future repository integration. A false or throwing mandatory
probe produces `GET /ready` HTTP 503 `{"status":"not_ready"}` while
`/health` stays 200. No live PostgreSQL was used in issue #9.
SIGINT/SIGTERM close Fastify. Logs intentionally exclude HTTP request bodies,
headers and environment values. Before private endpoints, #13 must implement
authentication/authorization and a production rate-limiting policy.


### PostgreSQL/Prisma projection baseline (#8)

Start a disposable local PostgreSQL 16 instance with `docker compose --profile
db up -d postgres`, set `DATABASE_URL` in your shell (never check in actual
secrets), and run `npm run db:validate`, `npm run prisma:generate`, then
`npm run db:migrate`. For development only, the local Compose test URL is
`postgresql://pce:pce_dev_only@127.0.0.1:5432/pce?schema=public`.

Run `PCE_DB_TEST_URL="$DATABASE_URL" npx vitest run
packages/db/src/index.integration.test.ts` against that disposable DB.
PostgreSQL 16 GitHub Actions verifies migration replay and concurrency tests
using synthetic fixtures and read-only repository permissions.
The API now **fails closed** on a configured but unreachable database; without
`DATABASE_URL` and with `API_REQUIRE_DB=false` it retains the safe public-only
mode. No private note routes are exposed before #13.

See [full projection contract](../packages/db/README.md).

### Interim auth configuration and local synthetic testing (#13)

`NODE_ENV=production` requires all of `API_AUTH_ISSUER`,
`API_AUTH_AUDIENCE`, and `API_AUTH_HS256_SECRET` (server-only secret,
minimum 32 UTF-8 bytes). Any partially configured group is rejected. In
development/test, all three may be absent: the normal entry point exposes
public diagnostics only. Set the variables in a trusted local shell/secret
manager, **never** in `.env.example`, public CI secrets, mobile or web
bundles. The issuer must mint standard HS256 JWTs with matching `iss`,
`aud`, verified `sub`, `scope: "notes:read"`, `iat` and `exp` (at
most 3600 seconds apart). This API does not issue tokens.

`createApp({ dependencies: { notes, verifyToken } })` enables
synthetic scoped reads in tests; omitting `notes` disables all private
routes. The reader's methods must filter by the verified subject.
`GET /api/v1/notes` and `GET /api/v1/notes/:id` have typed contracts
in `@pce/contracts`. Both clients can use `getNotes({ baseUrl,
getAccessToken })` and `getNote(options, id)`; tokens are provided per
request, with optional `request` (mock transport) and `signal` (abort).
The client refuses non-loopback HTTP before retrieving a bearer token; local
HTTP is limited to localhost or literal IPv4/IPv6 loopback. A production
deployment additionally requires TLS ingress rate limiting,
a trusted token issuer, secure key storage, and persisted data ownership
before connecting the live notes projection. Local test:
`npx vitest run apps/api/src/app.test.ts apps/api/src/config.test.ts
packages/api-client/src/index.test.ts`.


### One-shot synthetic ingestion worker (#10)

After `npm run build` and `npm run db:migrate`, populate a **disposable**, absolute sandbox directory with schema-v1 files under `inbox/` and run:

```bash
WORKER_MODE=once WORKER_CONTENT_BACKEND=filesystem \\
  WORKER_CONTENT_ROOT=/absolute/path/to/synthetic-sandbox \\
  npm run start -w @pce/worker
```

A configured `DATABASE_URL` with reachable PostgreSQL is mandatory; the worker fails closed and never logs note contents or connection secrets. Default `npm run dev:worker` stays idle. Each one-shot invocation is bounded; a trusted external scheduler may invoke it repeatedly. See [ingestion state machine](05-ingestion.md) for durable retries, lease recovery, test coverage and the guarded GitHub backend. Neither public CI nor this command exercises a real private content repository by default.

### Minimal web and Expo read-only clients (#14)

Both app shells use the typed `@pce/api-client` for `GET /api/v1/notes`
and `GET /api/v1/notes/:id`. They show signed-out, loading, empty, error and
detail states; 401 clears the in-memory session, 403 reports missing scope,
and a 404 on the list reports that the API's optional private reader is
not enabled. A token is never saved to browser storage, native storage,
source control, or config. There is **no login/token issuance or refresh**
implementation. This is a synthetic, developer-only integration path, not
production access to private content.

Web development, in separate terminals:

```bash
npm ci
npm run build -w @pce/contracts
npm run build -w @pce/api-client
API_CORS_ORIGIN=http://127.0.0.1:4200 npm run dev:api
VITE_API_BASE_URL=http://127.0.0.1:3000 npm run dev:web
```

Visit `http://127.0.0.1:4200`. Use only a **short-lived synthetic** JWT
issued separately by a trusted local test issuer with `notes:read` scope.
The normal API entry point intentionally returns 404 for notes even with a
valid token: real list/detail can be smoke-tested against the
`createApp({ dependencies: { verifyToken, notes } })` synthetic fixture
adapter exercised in `apps/api/src/app.test.ts`. The existing projection
has no owner key and MUST NOT be attached to these routes.

Expo development:

```bash
# Use a trusted HTTPS development API reachable by the emulator/device:
EXPO_PUBLIC_API_BASE_URL=https://dev-api.example.test npm run dev:mobile
# Android emulator or USB-connected Android via adb reverse may instead use:
adb reverse tcp:3000 tcp:3000
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000 npm run dev:mobile
```

On an Android emulator, `10.0.2.2` reaches the host but is **not an
approved plaintext bearer-token destination**; use `adb reverse` loopback
or a trusted HTTPS endpoint. On a physical iPhone or Android device,
`localhost` refers to the device, not the host PC. Do not weaken the
client's HTTPS-only remote token rule for convenience. Expo's
`EXPO_PUBLIC_*` values become public bundle constants: configure only
the API URL, **never** the JWT signing key, bearer token, database
credentials or private repository token.

The Expo scheme is `pce://notes/<valid-note-id>`; opening a note target
selects a detail view but **never bypasses authentication**. It does not
register for, send, or claim push notifications. Verify JS compatibility
with `cd apps/mobile && npx expo export --platform android --output-dir
/tmp/pce-expo-export`; real Expo Go/device, iOS, OS deep-link delivery
and native networking were not validated by this code-only change.

Useful synthetic commands: `npx vitest run
packages/api-client/src/index.test.ts apps/web/src/App.test.tsx
apps/mobile/links.test.ts`, then `npm run typecheck`, `npm test`,
`npm run build` and `npm run docs:check`. Browser interaction, device
behavior and remote HTTPS termination require separate manual verification.

## Local workspace startup (#38)

Run `npm ci` once, then `npm run dev:local` from the mechanism repository.
The launcher loads root `.env`, builds packages, validates all discovered
Markdown, applies checked-in migrations and imports a read-only snapshot of
`inbox/` and canonical `notes/YYYY/MM/` files. It never moves, edits, commits
or pushes content. Other content directories are excluded; symlinks,
noncanonical paths and duplicate note IDs fail startup. Invalid note content
is skipped with a count; the original file remains untouched for repair.
Only counts are logged. Install Node 22.12+ and npm 10+ first.

Required: `DATABASE_URL` in ignored root `.env`. Optional:
`PCE_CONTENT_ROOT` (default sibling `../personal_context_engine_content`),
`API_PORT` (default 3110), `PCE_WEB_PORT` (default 4310).
An existing `API_PORT` in `.env` takes precedence. Ports must be free;
stop earlier API/web instances before running. The API and web listen only
on `127.0.0.1`. Open the printed web URL using that exact hostname.
Ctrl-C stops both services. Ordinary `npm run dev`, the worker and Expo
remain unchanged; they do not acquire local workspace credentials.

The web obtains a 15-minute `notes:read` session automatically from its
same-origin development server. Clear session removes it from memory;
Connect local workspace obtains another. No token or signing key is
written to disk or browser storage. Restart generates a new server key.
The session endpoint rejects alternate Host/Origin, cross-site requests,
non-loopback peers and non-GET methods. This assumes a trusted local OS
account and browser; it is not a hosted login solution.

The additive migration gives notes nullable `ownerSubject`. This launcher
assigns `local-developer` when creating rows and SQL-scopes reads by both
that owner and IDs validated from the configured checkout. Legacy unowned
rows and different owners are not adopted or exposed. Importing such an
ID fails; resolve ownership explicitly before retrying. A changed source
revision also fails rather than silently overwriting another importer.
For new GitHub captures, pull the content checkout and restart this command.
An unchanged snapshot replays idempotently. No deletion is inferred when a
source disappears. Authentication for mobile and hosted users, source
conflict repair, scheduled refresh and production ownership provisioning
are outside this local startup path.

Validation: `npm run build`, `npx vitest run scripts/local-runtime.test.mjs`,
`npm test`, `npm run lint`, `npm run typecheck`, `npm run docs:check`.
The database integration suite verifies persisted ownership replay and
rejects reassignment/adoption using synthetic records in a disposable DB.
