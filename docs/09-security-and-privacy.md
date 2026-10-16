# 09 — Security, privacy and data retention

## Critical repository privacy precondition

`vokerg/personal_context_engine_content` is **intended** to be private. Repository visibility must be verified as **Private** before putting any personal, sensitive or production content into it. The owner has indicated this visibility change will be done separately. Until verified, use only synthetic test notes.

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
- Back up DB and repo separately; test restore, replay and credential rotation.
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

## ChatGPT custom MCP write adapter (issue #28)

A separate remote MCP endpoint may write only to the configured **private** inbox with OAuth owner/issuer/audience/scope verification and server-side GitHub credentials. The endpoint must remain loopback-only behind an HTTPS proxy; do not confuse the OAuth identity token with the GitHub content token. Full chat transcripts are **not** automatically available to plugins and must be explicitly supplied and confirmed before saving. Private Git history may retain saved transcripts. See [MCP setup and threat boundaries](13-chatgpt-mcp.md).
