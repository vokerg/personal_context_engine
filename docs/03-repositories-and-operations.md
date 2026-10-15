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

The API binds to `127.0.0.1:3000` by default, with `API_PORT` supported. Its only route is `GET /health`. The worker starts/stops without ingesting data. React web is a static scaffold and the Expo app is a native scaffold; neither reads private content. Running Expo on a real device needs local Expo tooling, a compatible emulator/device, and separate device-reachable API configuration when auth arrives. CI does **not** claim native simulator validation. `db:migrate` is **not implemented** until issue #8.

## Environment and credentials

Future **server-only** configuration (examples, not current environment variables; only `API_PORT` exists today):

```dotenv
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...
CONTENT_REPOSITORY=vokerg/personal_context_engine_content
CONTENT_BRANCH=main
CONTENT_STORE_PROVIDER=github
CONTENT_GITHUB_TOKEN=...
API_AUTH_MODE=...
LLM_PROVIDER=disabled
PUSH_PROVIDER=disabled
```

- The secret names and exact provisioning method are implementation proposals.
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


### Required public PR checks

Both workflows run on **every** `pull_request` (including documentation-only changes) and `push` to `main`. They deliberately have **no path filters**, so workflow/configuration/script changes cannot accidentally suppress a required status check. The jobs run independently and do not depend on production services.

| Check | Workflow / job | What it executes |
| --- | --- | --- |
| Application quality | `Workspace checks / workspace` (`.github/workflows/bootstrap.yml`) | `npm ci --no-audit --no-fund`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test` (also runs `npm run build`), Expo Android JavaScript export, and scaffold API/worker process smoke |
| Documentation integrity | `Documentation / docs` (`.github/workflows/docs.yml`) | `node scripts/check-docs.mjs` (required documents and local Markdown links) |

Both use the repository's `.nvmrc` (Node 22) rather than a second workflow-specific version. `package.json` requires Node >=22.12 and npm >=10. The root `package-lock.json` must be committed and kept current; CI uses `npm ci`, not `npm install`. `npm test` builds the workspaces before running Vitest, so a separate build step would unnecessarily repeat compilation. Expo export is **JavaScript bundle validation**, not emulator/native build coverage. The process smoke targets the current no-database scaffold; when the API/worker gain required services, replace that smoke with hermetic injection/stubbed dependencies rather than supplying production credentials.

Both jobs use `permissions: contents: read` and `actions/checkout` with `persist-credentials: false`. Never add `pull_request_target`, production/database credentials, private content repository tokens, real notes, or external provider calls to PR validation. Test fixtures and service adapters must be synthetic. `GITHUB_TOKEN` stays job-scoped and read-only. Neither workflow accesses the separate content repository.

#### Running checks and reproducing a failure

From a clean checkout, run:

```bash
nvm use
npm ci --no-audit --no-fund
npm run lint
npm run format:check
npm run typecheck
npm test
npm run docs:check
```

To verify a **negative documentation case**, temporarily add `[broken-test-link](file-that-does-not-exist.md)` to `README.md` and run `npm run docs:check`. It must exit nonzero with a `Broken link` diagnostic. Remove the temporary line and rerun the command before committing. A missing required documentation file likewise fails. Lint, typecheck, unit-test and bundle failures propagate as nonzero workflow steps; a job's green status is only evidence for that actual GitHub Actions run, not future code.

GitHub Settings → Branches / Rulesets should require both `workspace` and `docs` check contexts before merging to protect `main`. **A workflow file alone does not enforce branch protection.** If repository rules are not configured, request owner action; do not claim that checks are mandatory at the GitHub merge button. Optional device/simulator, integration-with-real-provider and production deployment tests remain out of scope for public PR workflows.

## Deployment decisions still open

Select hosting, database provider, user authentication, push infrastructure, scheduler, secure webhook delivery and backup/restore tooling during implementation. Document real costs and limits before promising "free" server-side LLM processing. GitHub storage and LLM providers are adapters, not product requirements.

## Operational recovery

Backup the database (including state and device registrations with appropriate protection) and the content repo independently. Test reimport from Markdown, replay after a worker crash, reconciliation of incomplete Git moves, and safe schema migrations. Remember Git history may retain supposedly deleted content; repository privacy is not an erasure policy.
