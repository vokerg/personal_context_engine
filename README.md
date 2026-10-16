# Personal Context Engine

**Personal Context Engine (PCE)** is an extensible, self-hostable system for capturing unstructured thoughts, preserving their original meaning, turning them into structured records, and surfacing relevant context later.

**Status: foundation with local deterministic ingestion and synthetic API authentication boundary.** This repository has starter API/worker processes, React/Vite and Expo shells, shared TypeScript workspaces, and pure synthetic-tested v1 Markdown capture validation/serialization in `@pce/core`. An opt-in one-shot worker supports filesystem/PostgreSQL ingestion and crash reconciliation; the normal worker command stays idle. There is no real login, owner-scoped database reader, production private-note ingestion, notification delivery or deployment. The documents distinguish agreed direction from implemented functionality.

## Two-repository design

| Repository | Access / purpose |
| --- | --- |
| [personal_context_engine](https://github.com/vokerg/personal_context_engine) | **Public mechanism:** application code, schemas, API, web/mobile clients, workers, synthetic examples, docs and CI. |
| [personal_context_engine_content](https://github.com/vokerg/personal_context_engine_content) | **Intended private content:** personal Markdown captures, processed notes, and ledgers. No application CI. |

**Privacy precondition:** The content repository must be switched to **Private before any personal content is added**. Do not infer privacy from its name. No credentials or real personal notes belong in this public repository.

## Product loop

1. Capture voice or text with minimal friction (initially a ChatGPT Project).
2. Normalize and classify each thought into versioned Markdown without discarding the original transcript.
3. Save new note files to a content repository inbox.
4. Let an idempotent worker validate, import into PostgreSQL, and move accepted files to date-based storage.
5. Present notes and derived information through the React web app and React Native / Expo mobile app.
6. Generate auditable daily, weekly, monthly, and per-project ledgers; later add reminders, notifications, semantic discovery, and carefully controlled actions.

The capture channel and LLM provider are replaceable. GitHub is an initial storage adapter, not a required long-term database.

## Planned stack

- **Web:** React, TypeScript, Vite.
- **Mobile:** React Native, Expo, TypeScript; notifications are a core product requirement.
- **Backend:** Node.js, TypeScript, Fastify.
- **Worker:** independently runnable Node.js process.
- **Persistence:** PostgreSQL with Prisma projections of Markdown source records.
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
- [ChatGPT custom MCP capture app](docs/13-chatgpt-mcp.md)

Agent instructions: [AGENTS.md](AGENTS.md).

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

For Expo, run `npm run dev:mobile` with a separately configured simulator/device development environment. Expo Go/native device launch and bundle compatibility must be verified on the target platform; the bootstrap CI only runs TypeScript checking, not an emulator or a production mobile bundle. A future authenticated API client must use a device-reachable host, not device `localhost`. PostgreSQL/Prisma migration and disposable local DB commands are available through `packages/db/README.md` (issue #8); authenticated note browsing remains blocked on #13. See [repository operations](docs/03-repositories-and-operations.md).

## Contribution and review

Non-trivial code, schema, infrastructure and architecture work **starts with a GitHub issue**. Follow the [contributor workflow](CONTRIBUTING.md), using the [implementation or bug-report templates](.github/ISSUE_TEMPLATE/) and the [PR template](.github/pull_request_template.md). Every implementing PR references its issue, includes actual verification evidence and requires explicit human authorization before merge; a coding agent must not approve its own PR or merge without that authorization. Prefer squash merges. Keep documentation synchronized with behavior.

Public CI must use synthetic fixtures only; runtime credentials for private content must never be available to untrusted PR workflows.
