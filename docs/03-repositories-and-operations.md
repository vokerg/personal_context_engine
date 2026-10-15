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

## Proposed public monorepo layout

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
package.json                 # introduced when application workspaces exist
```

Favor a modular monolith and independent process entry points over multiple deployable microservices. Share types, hooks or client logic only when actually portable; keep React DOM and React Native presentation separate.

## Local development target

Application scripts below are **planned, not currently runnable**:

```bash
nvm use
npm install
npm run db:migrate
npm run dev               # web + api, possibly local deps
npm run dev:worker
npm run build
npm test
npm run lint
```

Target development versions: Node.js 22.12+ and npm 10+, subject to upgrade when packages are added. Proposed local ports: API `http://localhost:3000`, web `http://localhost:4200` (configurable). `apps/mobile` will use Expo/Metro and a device-reachable API host instead of device `localhost`.

The documentation-only repository can be checked today with `node scripts/check-docs.mjs`.

## Environment and credentials

Planned **server-only** configuration (examples, not current environment variables):

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

## Deployment decisions still open

Select hosting, database provider, user authentication, push infrastructure, scheduler, secure webhook delivery and backup/restore tooling during implementation. Document real costs and limits before promising "free" server-side LLM processing. GitHub storage and LLM providers are adapters, not product requirements.

## Operational recovery

Backup the database (including state and device registrations with appropriate protection) and the content repo independently. Test reimport from Markdown, replay after a worker crash, reconciliation of incomplete Git moves, and safe schema migrations. Remember Git history may retain supposedly deleted content; repository privacy is not an erasure policy.
