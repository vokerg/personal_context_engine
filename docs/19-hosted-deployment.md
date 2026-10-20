# 19 — Vercel web and Render API (#79)

## Scope and status

Owner-selected deployment: Vercel hosts the static React web app; Render hosts
the authenticated Fastify API in Frankfurt, using the existing externally
provisioned PostgreSQL. Both providers deploy **main only**. Configuration in
this repository is reproducible setup, not proof that a deployment has completed.
Record actual provider verification in issue #79. Hosted ChatGPT/MCP acceptance
remains #49/#50; MCP is disabled for this deployment. The existing GitHub capture
and repository-search path remains available. Backup automation #61 is deferred.

## Vercel

Import `vokerg/personal_context_engine` as `personal-context-engine-web`, root
`.` and framework **Other**. `vercel.json` builds only contracts, API client and
web, with output `apps/web/dist`. Use Node 22 and `npm ci --include=dev`.
Set the production branch to `main`. The repository disables every other branch
with `git.deploymentEnabled`; the ignored-build script also skips unknown and
non-main refs. Do not enable preview deployments or give previews any secrets.

Production-only public environment variables:

```text
VITE_API_BASE_URL=https://personal-context-engine-web.vercel.app
VITE_PCE_SESSION_AUTH=true
VITE_PCE_DB_SEARCH=true
VITE_PCE_LOCAL_BROWSE=true
VITE_PCE_LOCAL_DEV=false
```

The web calls its own hostname. Vercel externally rewrites `/auth/*`, `/api/*`,
`/health` and `/ready` to the Render service. This preserves the current exact
origin checks and host-only Secure/HttpOnly/SameSite=Lax session cookie without
third-party cookies or relaxed CORS. Responses containing data or sessions retain
the API's `Cache-Control: no-store`. The frontend catch-all serves `index.html`.
Update the proxy destinations and both configured origins together if the
providers allocate different domains. No DB URL, provider key, signing secret,
username or password hash belongs in Vercel or a `VITE_*` variable.

## Render

Create a Node web service `personal-context-engine-api` from this **public code**
repository, branch `main`, root `.`, Frankfurt, free instance, auto-deploy on
commit and PR previews disabled. `render.yaml` records these settings; a service
created through the dashboard must have the same settings applied there.
The free instance can spin down when idle, so first requests may take longer.
Do not silently upgrade to a paid instance or add a scheduler.

Build:

```sh
npm ci --include=dev && npm run prisma:generate && npm run build -w @pce/core && npm run build -w @pce/contracts && npm run build -w @pce/db && npm run build -w @pce/api
```

Start:

```sh
node scripts/deploy-migrate.mjs && npm run start -w @pce/api
```

Health check: `/ready`. API binds `0.0.0.0` and Render's `PORT`; an explicit
`API_PORT` overrides `PORT`. Omit `API_PORT` in Render. The migration helper uses
`DIRECT_URL` when supplied and suppresses connection diagnostics; runtime retains
`DATABASE_URL`. A failed migration prevents API startup. Never disable advisory
locking to work around a pooled-connection migration failure.

Server-only configuration:

- `NODE_VERSION=22`, `NODE_ENV=production`, `API_HOST=0.0.0.0`, `API_REQUIRE_DB=true`.
- `PCE_AUTH_MODE=single-user`, `PCE_OWNER_SUBJECT=local-developer` (the existing
  persisted owner; never adopt unowned or differently owned records).
- `PCE_WEB_ORIGIN` and `PCE_API_ORIGIN` both equal the canonical Vercel HTTPS origin.
- `PCE_SINGLE_USER_USERNAME` and `PCE_SINGLE_USER_PASSWORD_HASH`: trusted operator
  credentials; hash format `scrypt-v1:<32 hex salt>:<128 hex derived key>` with
  N=65536/r=8/p=1/64-byte key. Store credentials privately outside the repository.
- `DATABASE_URL` (runtime pool) and `DIRECT_URL` (migration connection), both from
  the existing trusted PostgreSQL environment. Keep pgvector and current schema.
- `PCE_DB_SEARCH=true`, `PCE_MCP_ENABLED=false`; no OAuth clients yet.
- `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`
  stay server-only. Semantic query calls require explicit
  `PCE_EMBEDDINGS_ENABLED=true` and
  `PCE_EMBEDDING_EGRESS_APPROVED=I_APPROVE_PRIVATE_TEXT_TO_OPENAI`.
  These disclose selected query text to OpenAI using the existing bounded
  budgets and lexical fallback; they do not start corpus indexing.

The public Blueprint requires operator entry for secrets and egress gates.
Do not copy the entire local `.env`: local bootstrap/GitHub tokens, ports and
OAuth registrations are inappropriate here. No GitHub credentials or content
checkout are required by the API. Existing local GitHub ingestion can keep
feeding the same DB. Hosted ingestion, DB preparation and embedding schedules
are separate work; no such processes are launched by this web service.

## Hosted DB reader (#81)

The standalone API attaches the trusted timeline/tag/detail reader only when
single-user sessions and `PCE_DB_SEARCH=true` are explicitly configured. It
reads all DB originals for the verified owner, including API-only notes, without
requiring a content checkout. The local launcher retains its additional snapshot
allowlist; an empty allowlist still exposes nothing. Pages stay bounded at 24
notes, and the legacy list route returns one bounded page. Facets and original
source detail apply the same SQL owner predicate. No unowned rows are adopted.

## Verification and rollback

Verify provider settings show the correct repository, branch `main`, no PR
previews, and expected build/start commands. Verify both direct Render and
proxied Vercel `/health` and `/ready` over HTTPS. `/auth/config` must report
`single-user`; anonymous private search must return 401, never source content.
Sign in through Vercel, confirm Secure/HttpOnly session and separate CSRF
cookies, and exercise authenticated keyword search/source opening without
publishing note bodies, IDs, credentials or provider responses. Check logout
revokes access. Test semantic queries only with the explicit egress opt-in;
record provider/fallback status accurately. Do not equate DB readiness with
OpenAI API-key validity or ChatGPT acceptance.

Roll back to the previous compatible main deployment through each provider;
keep additive DB migrations and originals intact. Disable semantic processing
by setting `PCE_EMBEDDINGS_ENABLED=false` and redeploying; keywords remain
available. Keep MCP disabled until same-host OAuth/discovery/proxy compatibility
is independently validated. Existing repository search is the fallback; this
deployment does not authorize a ChatGPT retrieval cutover.
