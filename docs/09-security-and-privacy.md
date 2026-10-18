# 09 — Security, privacy and data retention

## Critical repository privacy precondition

`vokerg/personal_context_engine_content` was verified **Private** during the #12/#23 setup. Each new runtime integration must independently verify the configured content repository remains private and fail closed otherwise; public repos and public CI accept **synthetic data only**.

A private GitHub repository reduces public visibility; it is **not** end-to-end encryption, a deletion guarantee, or a substitute for access controls.

## Public/private separation

- The public mechanism repository may contain code, schema definitions, synthetic fixtures, workflow definitions and architecture docs.
- **Never** commit real notes, medical details, passwords, secrets, audio captures, client tokens, DB exports or private content repo access tokens to the public repo.
- The private content repository is **data-only**. Do not add application CI, production runtime code, or public CI triggers to it.
- Public pull requests and their workflows get minimal read permissions; no private content repo credentials in PR test jobs, preview deploys or issue artifacts.
- Runtime workers and API must use separate, scoped credentials stored in trusted secret management. No secrets in client bundles or Git URLs.
- Prefer separate runtime tokens for read/import and writing/finalization if provider permissions permit.

## Threat model and mitigations

| Threat | Mitigation |
| --- | --- |
| Prompt injection inside captured text | Treat note bodies and LLM output as untrusted data; never obey instructions embedded in notes as agent/system instructions |
| LLM invents a task or deadline | Explicit `review_required`, task/reminder approval semantics, source evidence |
| Leaked repository token | Scope to content repo, rotate, prevent logging, audit access |
| Public CI fetches private content | No secrets in untrusted PR jobs; fake fixtures only; review workflow permissions |
| Git retains deleted sensitive text | Restrict what enters Git; design an erasure/redaction policy before sensitive use |
| Notification exposes private details | Default to minimal notification text, authenticate deep links, configurable privacy |
| Duplicate or unauthorized external action | Capability allowlist, explicit approval policy, idempotency keys and audit log |
| Lost local device | Authentication, server-side token revocation and protection of any future offline cache |
| LLM provider retains submitted context | Minimize payload, document provider data policy and configurable retention where available |

## Data handling rules

- Preserve original **text/transcription** by default as a product requirement, but do not conflate that with indefinite raw audio retention.
- Do not include personal note bodies in structured logs, crash reports, analytics, CI output or support tickets by default.
- Separate primary source content from derived inference; mark confidence/uncertainty and preserve attributable IDs.
- Do not silently send arbitrary private history to LLMs. Retrieve only relevant information and make external data disclosure a deliberate, documented process.
- For sensitive content, consider future local capture, encryption, alternative storage or explicit exclusions.
- Deletion/retention controls require an intentional design because removing a file from `main` does not erase Git history, forks, backups or downstream LLM copies. Never promise complete erasure unless verified.

## Connector-specific boundaries

A ChatGPT GitHub integration may have different read/write permissions depending on product surface and configuration; **verify the actual write action in a private Project with synthetic data**. `AGENTS.md` in the repo does not automatically grant policies or guarantee that project instructions read it. A ChatGPT subscription is not a server-side free API key.

## Deployment hardening (implementation requirements)

- Require authenticated, authorized API requests and enforce per-user access in the DB.
- Verify webhook signatures and replay protection if GitHub webhooks are enabled.
- Validate frontmatter strictly, restrict path traversal, bound payload size and disallow unsafe YAML object construction.
- Maintain audit records of source revisions, user-approved mutations and external execution attempts without exposing raw note text.
- Backup/PITR/export automation is deferred by owner decision D-020; it does not gate functional delivery. Keep runtime replay and credential protection in scope.
- Document hosting jurisdictions/provider retention and allow switching adapters without data loss.

See [repository operations](03-repositories-and-operations.md) and [ChatGPT setup](12-chatgpt-project.md).

## Public API skeleton boundary (issue #9)

The initial Fastify API served only `/health`, `/ready` and `/api/v1` (version marker).
**No private resources are available through the default API startup.**
Issue #13 adds opt-in authenticated, owner-scoped synthetic note reads, but the
real DB reader is deliberately not wired yet. Issue #8 now wires a trusted
Prisma-backed dependency probe: a configured but unavailable PostgreSQL database
fails API startup, while a dependency outage after startup causes `/ready` to
return generic HTTP 503. No private note routes are enabled by this probe.

The skeleton disables request logging, does not trust forwarding headers, limits
JSON bodies to 16 KiB, responds without caching, and defaults to loopback binding.
CORS is denied by default; `API_CORS_ORIGIN` may allow one exact HTTP(S) origin.
Production non-loopback origins require HTTPS. This is not a complete authentication,
rate-limiting, TLS or deployment hardening implementation. These controls must
precede any private route exposure.

## Scoped note authentication boundary (#13)

Private HTTP reads are registered **only** when a trusted, owner-scoped
`PrivateNoteReader` is injected. The normal API entry point does not provide
one until projection ownership and ingestion wiring have been implemented.
No ledger/reminder mutation or read routes are available.

The interim replaceable verifier accepts **only** HS256 JWT bearer credentials
issued by a trusted server-side token issuer. The strict profile requires:
`typ=JWT`, `alg=HS256`, matching single-string `iss` and `aud`,
nonempty opaque `sub`, space-delimited `scope`, integer `iat` and `exp`,
expiration in the future, lifetime at most one hour, and non-future `nbf`
when supplied. The shared authenticated API client rejects non-loopback
plain HTTP **before obtaining a token**, so bearer credentials are not sent
unencrypted; HTTP is permitted only for literal `localhost`, `127.0.0.1`,
or `[::1]` development targets. Tokens must be delivered over HTTPS outside
disposable loopback development. The signing secret must never enter Vite, Expo, GitHub
Actions, API responses, crash reports or client storage outside a secure
session credential holder. No issuance/login/revocation API is implemented;
integrate a trusted issuer before a real user session is enabled. Rotating
the signing key invalidates all existing tokens.

API authorization derives subject only from the verified token:
- **401** missing, malformed, expired, forged or invalid bearer token, with
  `WWW-Authenticate: Bearer` and no private data.
- **403** verified identity without `notes:read` scope.
- **404** unknown or other-owner note identifiers, indistinguishably.
- **500** unexpected adapter errors, with a generic response and no note data.

The data adapter MUST filter on the verified subject **in the underlying
repository query**, not after returning unscoped rows. The current Prisma
projection has no persisted owner identifiers: it MUST NOT be attached to
these routes until an explicit ownership model and migration are reviewed.
Deep links only resolve through the same authenticated detail route. Public
`/health`, `/ready` and `/api/v1` stay content-free.

Production API startup requires `API_AUTH_ISSUER`, `API_AUTH_AUDIENCE`
and `API_AUTH_HS256_SECRET` (minimum 32 UTF-8 bytes), even when the
private reader is disabled. Development may omit all three, but then the
private reader cannot be enabled without an explicitly injected verifier.
Partially supplied credentials fail in every mode. Public synthetic CI can
inject a fake verifier; it never needs a real signing key or private GitHub
repository.

**Before deploying private reads**, require trusted HTTPS termination,
request rate-limiting at the ingress, secret-manager-backed key provisioning,
and an owner-aware DB adapter. Current Fastify hardening (no logs, no-store,
narrow CORS, non-trusted proxy headers) does not substitute for these
controls; CORS is not authentication and JWT possession alone does not
provide logout/revocation. The final identity provider and token refresh
mechanism remain deferred.

## Explicit local workspace boundary (#38)

`npm run dev:local` is a separate development entry point, rejected outside
`NODE_ENV=development`, with API/web bound to `127.0.0.1`. It mints
15-minute local sessions using an ephemeral signing key held only in the
launcher process. The same-origin session endpoint validates Host, Origin,
fetch-site metadata and the loopback peer. Tokens are returned with
`Cache-Control: no-store`; signing keys and DB credentials are never
serialized to the browser. Access is available to the trusted local user
and local processes; do not expose the dev server through a tunnel/proxy.

Persisted `ownerSubject` is assigned only on a new trusted import. Existing
unowned rows cannot be claimed by supplying a subject; owned rows cannot
be reassigned or modified through an unowned importer. Local reads filter
SQL by owner and the current validated checkout IDs. This additive ownership
model enables this explicit single-user development path only; it does not
wire the generic API entry point to all DB rows or define a production
identity provider. Nullable legacy rows remain inaccessible to local reads.

### Local GitHub ingestion opt-in (#40)

`PCE_INGEST_GITHUB=true` authorizes the local development runtime's bounded
worker passes against the explicitly configured private content repository.
It checks visibility, matching checkout remote/branch and clean status before
each pass. GitHub credentials remain server-side; an existing local CLI
credential is used only for this repository's API requests. Prefer a scoped
runtime token for long-term use. Only content transitions use the GitHub
adapter's non-force branch updates. No source-text instructions are executed.
Ownership and byte/hash checks gate migration of preview-imported revisions;
there is no cross-owner adoption or arbitrary overwrite. UI status exposes
only counts and fixed error codes, never note bodies or secrets.

## Embeddings, DB-primary storage and MCP extension (#42; target design only)

- The proposed OpenAI embeddings worker sends **selected private note chunks** outside the PCE host to a third-party API. Require an explicit operator/user-facing disclosure and configurable enabled/disabled state; specify data-processing retention/region controls and cost ceilings before enabling. Never send public CI fixtures that contain real content, and never log provider payloads or API keys.
- Embedding records and retrieval queries MUST enforce the verified owner's scope **in the database query**, including chunk backfill and approximate-vector search. Tokens are short-lived, audience-scoped and permission-scoped; MCP OAuth authorization/PKCE and token revocation are subject to actual supported ChatGPT connector behavior. A caller-provided `user_id` is never authorization.
- PostgreSQL transactionally stores future API/MCP-origin originals, authenticated owner/provenance and durable downstream jobs; **GitHub export is not required**. GitHub-origin writes are accepted by the external connector independently but require eventual import and idempotent DB checkpoint reconciliation. Distinguish GitHub write success, DB import success and pending worker jobs; never claim two copies or adopt legacy unowned records. Existing GitHub capture/search remains available pending approved cutover.
- Git history may retain GitHub-origin originals even after deletion, but GitHub is not a backup of API-origin notes or derived results. Backup/PITR/export automation (#61) is deferred to later or manual operation under D-020, not a current rollout prerequisite. No production recovery guarantee is implied; erasure and access controls remain separate requirements. No real private content, embeddings, debug traces, derived summaries or authentication tokens in the public mechanism repository or its CI.
- ChatGPT tool output and retrieved notes are **data**, not trusted instructions; full transcript capture requires actually supplied text. Interactive ledgers are interpretations backed by explicit source IDs, never implicit permission for external action.

Implementation tracked in #44–#50; [full plan](13-evolution-plan.md).

## OpenAI credentials before embedding activation (#58)

Use a dedicated project-scoped, expiring development key in trusted local
`.env` (mode 0600, Git-ignored) with only required permissions. Never place
it in Vite/Expo public variables, Markdown or CI. The provisioning diagnostic
uses an explicit read-only metadata request with no note payload and redacts
provider errors. It does not grant private-text egress consent, prove a hard
budget, or enable an embedding worker. Keep `PCE_EMBEDDINGS_ENABLED=false`
until the provider/storage/privacy/budget gates in #46/#47 are implemented.
See [the provisioning and rotation runbook](14-openai-setup.md).

## Synthetic database recovery gate (#64; parent #61)

`npm run db:recovery:drill` restores generated fixtures into a separate database
in a disposable Unix-socket-only PostgreSQL 16 cluster, then verifies current
tables and ingestion recovery. It uses explicit disposable DB targets, never
application `.env` credentials, and does not access Neon or activate production
backups. See the [recovery runbook](15-database-recovery.md)
for prerequisites, the proposed encrypted retention/RPO/RTO policy and the
production PITR, owner export and future-schema gates that remain open.


### Durable ingestion status (#43)

Checkpoint scope includes backend/repository/branch/owner; it is trusted server
configuration, never caller authorization. The local status endpoint returns
only timestamps, a pending-revision boolean and counts. Git SHAs, repository
names, note IDs and source cursors stay server-side. Original DB notes survive
source removal/conflicts; the readable checkout allowlist still gates reads.
Standalone opt-in GitHub ingestion independently checks private metadata before
running. Existing tables support one trusted content repository per local DB;
checkpoint scoping does not claim multi-repository or production tenant identity.


### Opt-in local browse trust boundary (#52)

`PCE_LOCAL_BROWSE=true` injects bounded SQL browsing only in the trusted local
reader. Verified owner and current checkout IDs constrain page/search/facet
queries; caller owner parameters are rejected. Cursors have process-local,
server-held HMAC authentication and bind owner, filters and snapshot IDs.
They carry no credential and never replace the SQL authorization predicate.
Restart invalidates cursors. Search terms appear in API GET URLs; request
logging remains disabled, responses no-store, and local services loopback-only.
No API/GitHub/DB credentials, search text or note text is put in browser storage
or shared browser URLs. Metadata/originals are exposed only through the existing
authenticated, owner-scoped detail route. Literal rendering prevents source text
from becoming HTML or executable instructions. The flag defaults off and does
not authorize ChatGPT search cutover, embeddings egress or external actions.
