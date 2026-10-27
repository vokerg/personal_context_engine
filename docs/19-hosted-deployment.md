# 19 — Vercel web and Render API (#79)

## Owner-approved independent Tasks (#147/#154)

The 2026-10-26 rollout enables `PCE_TASKS_ENABLED=true` in the existing Render
service and production-only `VITE_PCE_TASKS=true` in Vercel, with redeployment and
actual authenticated UI verification. The public/default configuration remains
off. Additive Task migrations are retained on rollback.

The existing ChatGPT client allows `notes:read tasks:read tasks:write`; the
existing native client retains read/capture/tag scopes and additionally allows
`tasks:read tasks:write`. Keep exact existing client IDs, redirects, issuer and
audience. Registration is permission to request scopes, not an upgrade of stored
grants. Verify a **fresh consent page explicitly names the Task scopes**, and
refresh the ChatGPT tool catalog after reconnecting. The old ChatGPT connection
initially requested only notes:read; this required an explicit Task-scope request
at consent, not a silent server-side grant expansion. Task writes mutate records
only and never execute their text.

GitHub Task ingress is a separate trusted **local** DB-jobs loop, using private
visibility checks and the GET-only adapter. No worker, scheduler, provider spend
or GitHub credential was added to Render/Vercel. The Mac/runtime must run for DB
import; GitHub batches remain durable and reconcile after downtime. See
[actual activation, native checks and rollback limits](evidence/issue-154/2026-10-26-activation.md).

## Scope and status

Owner-selected deployment: Vercel hosts the static React web app; Render hosts
the authenticated Fastify API in Frankfurt, using the existing externally
provisioned PostgreSQL. Both providers deploy **main only**. Configuration in
this repository is reproducible setup, not proof that a deployment has completed.
Record actual provider verification in issue #79. The public Blueprint keeps
MCP disabled by default; the existing owner-configured hosted connection was
actually exercised during #105 acceptance. See the optional MCP/report sections
below and [the current acceptance record](12-chatgpt-project.md). The existing
GitHub capture/repository-search path remains available. Backup automation #61
is deferred.

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

Production builds retain these explicit public `VITE_*` settings; they never
infer browser features from Render's server-only `PCE_*` settings. Production
always uses browser session authentication, including when the public session
flag is missing. Without an explicit API base URL it uses the browser's own
origin. Authentication discovery shows a loading or retry state, never the
synthetic JWT form. Development JWT entry and automatic development-session
bootstrap are limited to Vite development runtime. A failed logout retains the
session UI and offers a retry; only a successful logout or an already-expired
session clears it. Password sessions and delegated MCP OAuth remain separate.

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

## DB-only manual tags (#103)

With existing session authentication and `PCE_DB_SEARCH=true`, the API also enables owner-scoped per-note `PATCH /api/v1/notes/:id/tags`. Only `tags:write` grants or session cookies with the existing origin/CSRF checks may mutate tag overrides. Deployed PostgreSQL must be migrated to include `note_tag_overrides` before serving this version. Original GitHub and API capture tags, content hashes, revisions and embedding chunks remain unchanged; only the effective tag view changes. A 409 indicates the note tags changed in another tab and requires a detail reload. There is no content-repo write, new background worker, paid service, or live NOTES prompt activation.

## Reversible note removal and archiving (#120)

Deploy the `20261024060000_note_removal` migration before enabling the hosted
detail action. `DELETE /api/v1/notes/:id` is gated by `notes:write`, uses the
verified session owner, and hides the row from all normal timeline/detail/search
and worker candidates while retaining the original and provenance in PostgreSQL.
It does not delete GitHub content or claim erasure. `PATCH
/api/v1/notes/:id/archive` uses the same scope and toggles a separate archive
state; archived notes remain in API/MCP/search responses with an explicit
`status`. The web defaults to active notes and offers archived/all selection.
Verify explicit browser confirmation, archive toggling, generic 404 behavior
for foreign/repeated IDs, strict removal no-body/query rejection and strict
archive-body validation using synthetic notes. There is no permanent-delete
operation in this release.

## Optional research report rollout (#104/#105)

The merged code keeps report API/search/MCP retrieval off unless Render has
`PCE_RESEARCH_REPORTS=true`. Existing authenticated sessions, database ownership,
`PCE_DB_SEARCH=true` and the current MCP OAuth configuration remain required.
Vercel additionally needs production-only `VITE_PCE_RESEARCH_REPORTS=true` and a
new build to expose report detail/history/status. These flags contain no secrets.
They do not start a worker or change OAuth scopes. The existing trusted local
worker imports GitHub reports into the shared DB independently of hosted reads.

During #105 actual browser acceptance, note capture and report DB import worked,
but the hosted connector had no report reader because the Render flag was absent.
The missing flags were added and current main redeployed on both providers.
Actual PCE compatibility fetch then returned the report with correct parent,
revision and generated-research type; the authenticated hosted web displayed
research/history/status and source provenance separately from the original.
Readiness was 200 and anonymous report access 401 with no-store. The client tool
catalog still omitted the dedicated reader, so the supported fetch fallback was
used. A DB row alone is not proof of deployed retrieval. Do not copy local
credentials or enable preview deployments to fix it.
Rollback sets the flags false and redeploys, retaining originals/report history.

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

## Optional ChatGPT MCP routing

The proxy also forwards `/mcp`, `/oauth/*` and `/.well-known/*`. MCP remains off
in the public blueprint. For explicit operator opt-in, configure the trusted
Render `PCE_MCP_TRANSPORT_ORIGIN` and exact `PCE_OAUTH_CLIENTS` before enabling
`PCE_MCP_ENABLED`; see [MCP client setup and verification](18-mcp.md).
Never send database, GitHub or OpenAI credentials to ChatGPT's client form.

## iOS native OAuth registration (#122)

The existing Vercel issuer `https://personal-context-engine-web.vercel.app`
must remain identical to the mobile `EXPO_PUBLIC_API_BASE_URL` (an origin,
without path, username, query or fragment). It forwards `/oauth/*` and
`/.well-known/*` to Render; session cookies authenticate the *system-browser*
login/consent page, **not** native fetch requests.

Render operator sets:

```text
PCE_MOBILE_OAUTH_ENABLED=true
PCE_MOBILE_OAUTH_CLIENT={"clientId":"pce-ios","redirectUris":["pce://oauth/callback"],"scopes":["notes:read","capture:write","tags:write"]}
```

The app's **public** build configuration supplies the matching values:

```text
EXPO_PUBLIC_API_BASE_URL=https://personal-context-engine-web.vercel.app
EXPO_PUBLIC_OAUTH_CLIENT_ID=pce-ios
```

Pick an operator-approved unique client ID and register it identically; the
sample above is not a credential or an authorization. Keep `PCE_AUTH_MODE`,
the existing owner subject, database connectivity and HTTPS issuer configured.
**Do not** enable `PCE_MCP_ENABLED` merely to enable the iPhone app; its MCP
connections, transport, registrations and tool exposure remain independent.
The OAuth resource remains `<issuer>/mcp` for backward compatibility, and
the public client uses no client secret. Registration is static and trusted:
only `pce://oauth/callback` is permitted for this client. Native redirects
require an iOS custom development build or TestFlight build with `scheme:pce`,
not Expo Go. Universal-link domain ownership is not claimed.

**Before rollout:** verify configuration loads, discovery and the callback
consent redirect using synthetic login/PKCE over an actual TLS listener. Then
verify in an iOS development build that a real system-browser consent returns
to the owning app and that the app checks expected state, issuer and registered
URI before exchanging a one-time code. Confirm secure refresh storage and
rotation, logout revocation, denial, 401/403, offline recovery and cold launch.
The security model assumes custom URI schemes are not exclusive on iOS; PKCE
protects code redemption if another app intercepts the code, but does not
guarantee that the legitimate app receives the callback. Record device
findings separately; remote synthetic tests do not prove live authorization.

**Rollback:** set `PCE_MOBILE_OAUTH_ENABLED=false`, unset
`PCE_MOBILE_OAUTH_CLIENT`, and redeploy Render. Already issued grants
should be revoked by the owner/operator; disabling a client registration
prevents refresh/revocation through those routes but does not itself erase
its persisted grants. Never publish signing keys, credentials or refresh
tokens in Expo public config, screenshots or build logs.
