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
npm run dev              # API :3000, idle worker and Vite web :4200
npm run dev:mobile       # separate Expo/Metro dev session
```

The API binds to `127.0.0.1:3000` by default; `API_HOST` and `API_PORT` are validated at startup. Public `GET /health`, `GET /ready` and `GET /api/v1` are implemented. Private note routes are registered only if an authenticated, owner-scoped note reader is explicitly injected (#13); default startup still exposes only public endpoints. The DB projection package lacks persisted ownership and is not wired to private reads. The worker starts/stops without ingesting data. React web is a static scaffold and the Expo app is a native scaffold; neither reads private content. Running Expo on a real device needs local Expo tooling, a compatible emulator/device, and separate device-reachable API configuration when auth arrives. CI does **not** claim native simulator validation. `db:migrate` applies the checked-in Prisma/PostgreSQL projection migration (issue #8); see [DB setup](../packages/db/README.md).

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

\`NODE_ENV=production\` requires all of \`API_AUTH_ISSUER\`,
\`API_AUTH_AUDIENCE\`, and \`API_AUTH_HS256_SECRET\` (server-only secret,
minimum 32 UTF-8 bytes). Any partially configured group is rejected. In
development/test, all three may be absent: the normal entry point exposes
public diagnostics only. Set the variables in a trusted local shell/secret
manager, **never** in \`.env.example\`, public CI secrets, mobile or web
bundles. The issuer must mint standard HS256 JWTs with matching \`iss\`,
\`aud\`, verified \`sub\`, \`scope: "notes:read"\`, \`iat\` and \`exp\` (at
most 3600 seconds apart). This API does not issue tokens.

\`createApp({ dependencies: { notes, verifyToken } })\` enables
synthetic scoped reads in tests; omitting \`notes\` disables all private
routes. The reader's methods must filter by the verified subject.
\`GET /api/v1/notes\` and \`GET /api/v1/notes/:id\` have typed contracts
in \`@pce/contracts\`. Both clients can use \`getNotes({ baseUrl,
getAccessToken })\` and \`getNote(options, id)\`; tokens are provided per
request, with optional \`request\` (mock transport) and \`signal\` (abort).
A production deployment additionally requires TLS ingress rate limiting,
a trusted token issuer, secure key storage, and persisted data ownership
before connecting the live notes projection. Local test:
\`npx vitest run apps/api/src/app.test.ts apps/api/src/config.test.ts
packages/api-client/src/index.test.ts\`.
