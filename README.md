# Personal Context Engine

**Personal Context Engine (PCE)** is an extensible, self-hostable system for capturing unstructured thoughts, preserving their original meaning, turning them into structured records, and surfacing relevant context later.

**Status (2026-10-20): locally tested single-user capture, indexing and search.** The optional local runtime supports SportOS-style single-user sessions, durable DB-first API/MCP capture, bounded OpenAI embedding passes and gated lexical/hybrid search in the web reader. The existing private-GitHub capture/import path remains available. The default worker stays idle, all provider calls require explicit enablement, and public CI uses synthetic data. Hosted HTTPS deployment, actual ChatGPT connector acceptance, automatic ledgers and push notifications remain unimplemented or unverified; see the linked runbooks for exact boundaries.

## Next direction: independent capture inputs and PostgreSQL processing

**Current:** private GitHub Markdown remains a working optional capture/search channel. Authenticated API/MCP capture can commit originals, owner provenance, idempotency receipts and processing jobs directly to PostgreSQL. Separate bounded workers prepare chunks and optionally index them with `text-embedding-3-small`; gated web/API retrieval searches DB originals, including API-only notes. OAuth consent shares the same single-user login; the official MCP client is tested locally.

**Remaining target:** independently deployed HTTPS ingestion/MCP, an observed ChatGPT connector and retrieval cutover, richer DB processing, deliberate ledgers/reminders and push delivery. No hosted scheduler, remote connector compatibility or model-generated action authority is inferred from local tests. Backup automation remains deferred by owner decision D-020 (#61).

See [the project intent](INTENT.md), [coexistence plan](docs/13-evolution-plan.md) and [delivery epic #42](https://github.com/vokerg/personal_context_engine/issues/42). **No current capture route is being removed by this plan.**

## Two-repository design

| Repository | Access / purpose |
| --- | --- |
| [personal_context_engine](https://github.com/vokerg/personal_context_engine) | **Public mechanism:** application code, schemas, API, web/mobile clients, workers, synthetic examples, docs and CI. |
| [personal_context_engine_content](https://github.com/vokerg/personal_context_engine_content) | **Private optional capture input / legacy archive:** GitHub-origin Markdown, historical finalized notes. Not a mirror of all API-origin originals or DB-derived ledgers. No application CI. |

**Privacy precondition:** The content repository must be switched to **Private before any personal content is added**. Do not infer privacy from its name. No credentials or real personal notes belong in this public repository.

## Product loop

1. Capture voice or text through private GitHub Markdown **or** optional authenticated API/MCP.
2. Preserve original content, schema and provenance; commit API-origin notes directly to PostgreSQL.
3. Idempotently import GitHub-origin notes to PostgreSQL with durable checkpoints. The existing importer currently also moves GitHub files; removing that dependency is future work.
4. Run enrichment, embedding, reminder and ledger workers from durable **DB jobs**, persisting derived results to DB.
5. Expose owner-scoped database browsing and retrieval through API and web, with optional MCP and a separate mobile preview; keep GitHub search until approved cutover.
6. Back up/restore PostgreSQL and offer optional explicit portable export, not automatic GitHub replication.

The capture channel and LLM provider are replaceable. GitHub is an optional input adapter/legacy archive, not the long-term processing backend.

## Planned stack

- **Web:** React, TypeScript, Vite.
- **Mobile:** React Native, Expo, TypeScript; notifications are a core product requirement.
- **Backend:** Node.js, TypeScript, Fastify.
- **Worker:** independently runnable Node.js process.
- **Persistence:** PostgreSQL/Prisma, with GitHub imports plus DB-first API originals, durable processing jobs and versioned derived artifacts.
- **Monorepo:** npm workspaces, shared domain and Zod/HTTP contracts.
- **LLM:** ChatGPT Project for early interactive capture and summaries; pluggable providers for later automation.

## Documentation

Start at **[docs/README.md](docs/README.md)**. In particular:

- [Product vision and invariants](docs/01-vision.md)
- [System architecture](docs/02-architecture.md)
- [Repository, environments and operations](docs/03-repositories-and-operations.md)
- [Capture and Markdown contract](docs/04-capture-contract.md)
- [Ingestion and lifecycle](docs/05-ingestion.md)
- [Domain model and taxonomy](docs/06-domain-and-taxonomy.md)
- [Ledgers and intelligence](docs/07-ledgers.md)
- [Web, mobile and notifications](docs/08-clients-and-notifications.md)
- [Security and privacy](docs/09-security-and-privacy.md)
- [Delivery roadmap](docs/10-roadmap.md)
- [Decision register](docs/11-decisions.md)
- [ChatGPT Project setup](docs/12-chatgpt-project.md)

Agent instructions: [AGENTS.md](AGENTS.md).

## Start a local workspace

With a root `.env` containing `DATABASE_URL` and the content checkout beside this repository:

```bash
npm ci
PCE_AUTH_MODE=dev-single-user PCE_DB_SEARCH=true npm run dev:local
```

Open `http://127.0.0.1:4310`. The local web session connects automatically;
no manually generated JWT is needed. The launcher builds the workspaces,
applies migrations using `DIRECT_URL` when configured (runtime queries retain
`DATABASE_URL`) and imports valid Markdown from the content checkout
without modifying it by default. Set `PCE_INGEST_GITHUB=true`,
`CONTENT_REPOSITORY` and `CONTENT_BRANCH` in `.env` to activate the real
worker: it persists inbox notes, commits canonical moves to the verified
private GitHub repo, and refreshes the checkout every 30 seconds while running.
Use an existing `gh auth` login or a scoped `CONTENT_GITHUB_TOKEN`.
API defaults to loopback port 3110. See
[local workspace configuration](docs/03-repositories-and-operations.md#local-workspace-startup-38).
The browser connects to one fixed local owner; no password is required on loopback
in `dev-single-user` mode. Hosted single-user password login is implemented but
must be deployed and verified over HTTPS. The web reader searches/opens notes;
capture is through the authenticated API/MCP or existing GitHub workflow.

Keyword search works without OpenAI. Approved local semantic-query tests also
require `PCE_EMBEDDINGS_ENABLED=true` and
`PCE_EMBEDDING_EGRESS_APPROVED=I_APPROVE_PRIVATE_TEXT_TO_OPENAI`, with server-only
credentials and current indexed chunks. These flags permit provider calls; do
not put keys in a client bundle. Indexing remains a separate explicit one-shot
worker, not an automatic startup task. Indexing and query requests share a
60,000-token daily reservation ceiling, with bounded request rates and lexical
fallback. See [search setup and rollback](docs/17-search.md),
[embedding operations](docs/03-repositories-and-operations.md#explicit-embeddings-pass-issue-47)
and [MCP/OAuth setup and remaining acceptance](docs/18-mcp.md).

## Local development (bootstrap)

Use Node.js 22.12+ and npm 10+ (`.nvmrc` pins the Node major). From the repository root:

```bash
npm ci
npm run lint
npm run typecheck
npm test              # also builds compiled packages and Vite web bundle
npm run docs:check
npm run dev           # API :3000, worker (idle until explicit opt-in), Vite web :4200
```

Alternatively run `npm run dev:api`, `npm run dev:worker`, or `npm run dev:web` separately. `API_HOST` and `API_PORT` configure the local bind address (see `.env.example`; values are not auto-loaded). Public `GET /health`, `GET /ready` and `GET /api/v1` expose liveness, mandatory-dependency readiness and API version. There are **no private note routes**; the worker deliberately does no ingestion. Configuring `API_REQUIRE_DB=true` or `DATABASE_URL` intentionally prevents startup until a trusted DB readiness adapter is integrated (#8).

For Expo, set a device-reachable `EXPO_PUBLIC_API_BASE_URL` and run `npm run dev:mobile` with a separately configured simulator/device development environment. Expo Go/native device launch and bundle compatibility must be verified on the target platform; the bootstrap CI only runs TypeScript checking, not an emulator or a production mobile bundle. Authenticated remote client calls require HTTPS; device `localhost` does not reach the host PC. See [client runbook](docs/03-repositories-and-operations.md#minimal-web-and-expo-read-only-clients-14). PostgreSQL/Prisma migration and disposable local DB commands are available through `packages/db/README.md` (issue #8); production note browsing still needs an owner-aware data reader and trusted token issuer. See [repository operations](docs/03-repositories-and-operations.md).

## Contribution and review

Non-trivial code, schema, infrastructure and architecture work **starts with a GitHub issue**. Follow the [contributor workflow](CONTRIBUTING.md), using the [implementation or bug-report templates](.github/ISSUE_TEMPLATE/) and the [PR template](.github/pull_request_template.md). Every implementing PR references its issue, includes actual verification evidence and requires explicit human authorization before merge; a coding agent must not approve its own PR or merge without that authorization. Prefer squash merges. Keep documentation synchronized with behavior.

Public CI must use synthetic fixtures only; runtime credentials for private content must never be available to untrusted PR workflows.

## OpenAI project groundwork

The optional [OpenAI setup runbook](docs/14-openai-setup.md) covers project
credentials and local configuration. `npm run openai:check` is offline;
`npm run openai:check -- --live` explicitly reads model metadata only.
Actual embedding processing remains disabled and unimplemented (#46/#47).
