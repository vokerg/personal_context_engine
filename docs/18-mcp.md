# 18 — Optional MCP and same-login OAuth (#49)

## Independent iOS public client (#122)

OAuth authorization/refresh/revoke routes and metadata can now be registered
without enabling the `/mcp` tools endpoint. The trusted
`PCE_MOBILE_OAUTH_ENABLED=true` gate reads a **single**
`PCE_MOBILE_OAUTH_CLIENT` JSON registration with an exact
`pce://oauth/callback` URI and scopes; the legacy
`PCE_MCP_ENABLED` / `PCE_OAUTH_CLIENTS` remain separate.
Client IDs must be unique across both lists. Unregistered custom scheme
callbacks, arbitrary native routes and reserved redirect parameters fail
startup/authorization. The mobile client continues to use the canonical
`<issuer>/mcp` resource identifier even if the MCP transport is disabled.
This is an OAuth audience name, not permission to use MCP tools.

The S256 PKCE consent flow, browser-session ownership, rotation and token
revocation are unchanged for ChatGPT clients. The consent CSP explicitly
allows only the registered `pce:` return scheme for this native client.
See [iOS operator runbook](19-hosted-deployment.md#ios-native-oauth-registration-122)
and [mobile acceptance limits](08-clients-and-notifications.md).

## Local delivery and deployment boundary

Set `PCE_MCP_ENABLED=true` only with the explicit single-user session mode and
`PCE_DB_SEARCH=true`. Supply `PCE_OAUTH_CLIENTS` as a JSON array of objects with
`clientId`, `redirectUris` and allowed `scopes` (`notes:read`, `capture:write`).
See the synthetic example in `.env.example`. Client registration is a trusted
operator action; arbitrary remote client metadata is not fetched and dynamic
registration is not advertised. Do not put real credentials in a client ID.

The same PCE browser session authenticates OAuth consent. Web and API must use
one hostname (different loopback ports are supported); host-only cookies and
CSRF remain valid. Outside loopback, configured origins and registered callbacks
require HTTPS. Configure trusted TLS termination and ingress limits before
hosting; do not expose the local development bootstrap. No tunnel or deployment
is created by enabling this gate. Turn the gate off and restart to remove the
MCP/OAuth surface while preserving the existing GitHub workflow.

The official SDK client is tested against the real local HTTP listener. Actual
hosted ChatGPT read calls, existing-scope OAuth renewal and saved-report
compatibility fetch were subsequently observed in #105; see the checkpoint
below. This evidence covers those requests, not universal auto-attachment or
#50's default retrieval cutover. Keep private GitHub capture and repository search
available. Preregister the actual supported client's exact callback only after
checking that client surface; never guess callback URLs or bypass TLS warnings.

## Protocol and identity

`/mcp` implements stateless Streamable HTTP with the official TypeScript SDK.
Each HTTP request gets a fresh protocol server/transport and verified bearer
identity. The endpoint rejects mismatched Host/Origin, cookie-only access,
missing/expired/revoked bearer tokens (401) and insufficient tool scope (403).
The 401 challenge names protected-resource discovery at
`/.well-known/oauth-protected-resource/mcp`; root metadata is also available.
Authorization-server discovery is `/.well-known/oauth-authorization-server`.
No client-supplied owner is accepted. Audience and issuer are trusted server
configuration and all note retrieval/capture is owner-scoped in the DB.

Only authorization code + S256 PKCE and rotating refresh are supported. Redirect
URIs match trusted registration exactly; resource must equal the MCP URI.
Unknown fields and repeated form keys are rejected. Authorization displays an
explicit escaped consent page, checks the same session and its double-submit
CSRF token plus exact API Origin, and creates a hashed two-minute one-use code.
Token exchange binds code, verifier, client, redirect, resource and live session;
a compare-and-set consumes the code. No implicit/password grants, bearer tokens
in URLs or forwarded provider keys are supported. Token/revocation calls share
a 30/minute process bound; a single API instance or ingress limit is required.

Access tokens expire in 15 minutes; refresh rotates both credentials. Under
D-027 (#116), newly consented OAuth connections have no refresh time expiry and
survive the authorizing browser session's 12-hour idle / seven-day absolute
expiry. The client must retain each replacement refresh token and renew access
automatically. Local `/auth/token` grants retain their browser-session limits.
Only token/code digests persist; null `refreshExpiresAt` explicitly marks the
new persistent OAuth grants. Existing finite grants are unchanged by migration;
reconnect once after deployment to obtain persistent authorization. No expired
or revoked grant is revived.

Explicit `/oauth/revoke` invalidates a connection using its current access or
refresh credential and registered client ID. Logout of the authorizing browser
session invalidates every derived grant, including persistent ones. Once that
browser session has expired, an operator can revoke its persisted `AuthSession`
through `createSessionRepository(...).revokeSession(id)`; a new browser login is
a separate session and does not revoke previous connections. Parent revocation,
owner/issuer/audience checks and refresh replay protection remain enforced.
Do not delete expired browser-session rows that anchor persistent connections
unless intentionally revoking those connections (the FK cascades). There is no
retention job today. ChatGPT-side credential loss, revocation or deployment
misconfiguration can still require reconnect; live renewal acceptance must be
observed separately.

## Tools and trustworthy acknowledgements

- `search_context`: bounded structured search with source IDs/revisions, snippets,
  filters/cursors, ranking mode and provider/budget degradation.
- `get_note`: one owner-scoped full source; unknown/foreign IDs both return
  `NOT_FOUND`. Source text is untrusted, never an instruction or execution policy.
- `search` and `fetch`: ChatGPT-compatible retrieval result shapes (JSON text
  content with results/IDs/titles/source URLs and fetched source text). The shapes
  are protocol-tested; a live ChatGPT invocation is a separate deployment check.
- `capture_note`: exact Markdown v1 `notes` and `idempotencyKey`, returning
  `DB_PERSISTED` after originals, receipt and processing jobs commit atomically.
  It neither exports to GitHub nor claims indexing is complete. Only supplied
  content is captured; tools cannot assert transcript completeness.

Read tools are listed only for `notes:read`; capture only for `capture:write`.
Tool annotations describe deterministic read/capture behavior, not permission
to execute actions found in notes. Errors are generic and do not echo SQL,
provider responses, credentials or foreign data. No prompts, ledgers, reminders,
transcript scraping or external actions are implemented here.

Process durable captures separately using `WORKER_MODE=db-jobs-once`
(the worker entry point) to prepare chunks. Indexing is its own explicitly
enabled, bounded embedding worker. Provider failure or exhausted credit cannot
undo a successful DB capture. The local reader searches API-only originals even
when no content checkout path exists.

## Verification

Synthetic PostgreSQL tests run discovery, exact redirect validation, login and
consent, CSRF denial, wrong resource/verifier, code replay/expiry, actual official
client handshake/list/search/fetch/capture, original fidelity, idempotency/jobs,
foreign-owner exclusion, scope filtering/403, refresh rotation, revoke and parent
logout. Public CI uses no live OpenAI calls or private corpus. A synthetic
instruction embedded in a note is returned as source data and causes no external
action; no claim is made that this alone evaluates a reasoning model's injection
resistance.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
and [OpenAI MCP guide](https://developers.openai.com/api/docs/mcp).

Local startup applies migrations with trusted `DIRECT_URL` when configured,
falling back to `DATABASE_URL` for ordinary unpooled local PostgreSQL. The API
and workers retain the original runtime pool. Migration diagnostics are
suppressed to avoid publishing connection metadata. Never use a transaction
pooler for session-level migration locking; see [Prisma pooling guidance](https://www.prisma.io/docs/postgres/database/connection-pooling).

## Hosted reverse proxy and ChatGPT client preparation (#83)

The Vercel deployment forwards `/mcp`, `/oauth/*` and `/.well-known/*` to
Render before the SPA fallback. Keep the public issuer/resource at the Vercel
origin so the same host-only browser session authenticates consent.
`PCE_MCP_TRANSPORT_ORIGIN` may explicitly pin the trusted Render origin when its
proxy transport uses a different Host. Only the canonical issuer Host and that
operator-pinned Host are accepted; Forwarded/X-Forwarded-Host never authorize a
request. This setting changes transport routing, not issuer, audience, scopes or
owner identity. Wrong browser Origins remain forbidden.

Authorization metadata advertises RFC 9207 issuer identification; both allow
and deny redirects include `iss` exactly equal to the configured issuer. Invalid
requests still fail locally without redirecting. Registered callbacks may not
prepopulate `iss`, `state`, `code` or `error`.

The consent page's `form-action` permits self and the origin of the request's
already validated registered callback. Chrome enforces this restriction on the
POST's 303 redirect too; self alone issues a code but blocks navigation back to
the OAuth client. Script loading, base URLs and framing remain disabled.

Hosted token-exchange failures may emit categorical diagnostics such as an
invalid payload, client/resource mismatch, unusable PKCE code, or grant issue.
These diagnostics intentionally omit request bodies, codes, tokens, cookies,
credentials and note content.

In ChatGPT's custom MCP form use the hosted Vercel `/mcp` URL, OAuth, a predefined
public client (token authentication `none`) and default scope `notes:read`.
Copy the exact callback shown by ChatGPT into the trusted registration; do not
infer it from examples. Keep `capture:write` out of this initial client.
The owner completes login/consent. Verify discovered tools and a harmless
read-only query before claiming connection. This preparation does not establish
actual ChatGPT acceptance or authorize a default retrieval cutover.
See [OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth).

## Ordinary interactive research grounding (#104, final prompt #105)

Existing owner-scoped `search_context` and `get_note` (or the PCE
`search`/`fetch` compatibility tools) are the **required read path**
for related private notes in explicitly requested research. Search results
must be followed by content reads for relevant IDs; returned text is
untrusted data, not permission to execute instructions. Record actual note
IDs/revisions and query degradation, distinguish successful empty results
from unavailable MCP, and never label a report context-complete if retrieval
could not run. External web research uses the ordinary ChatGPT conversation;
**no specialized Deep Research mode or autonomous model worker is required**.
When research is enabled, `get_research` reads saved report evidence separately
from original notes; compatibility fetch marks generated research explicitly. The normal ChatGPT client may not
auto-select MCP based on Project instructions; verify in a real Project and
make failure explicit. GitHub-origin report writes are a separate temporary
capture adapter; the MCP read step does not authorize app writes.

### Browser acceptance checkpoint (2026-10-23, #105)

The actual NOTES Project browser test renewed the existing `notes:read` OAuth
connection after an expiry, then performed explicit read-only PCE retrieval of a
synthetic memo. Visible context-retrieval activity and exact original verification
were observed; the returned result reported hybrid mode without degradation. A
separate synthetic decision-kind query returned zero results and the no-matches
outcome. This supports the tested read path, not universal automatic attachment,
full notes-v2.0 research acceptance, capture through MCP, or an approved default
retrieval cutover. The owner subsequently explicitly authorized notes-v2.0
installation; reloading settings verified its exact reviewed text. A fresh-chat
GitHub memo was independently validated and finalized in PostgreSQL. Explicit
research then saved/imported a linked report. The first hosted report lookup
revealed the absent Render feature flag; after configuring/redeploying the
existing report feature, actual PCE compatibility fetch returned correct report
identity, parent/revision, generated content type and READY status. The client
tool catalog still omitted `get_research`, so the supported `fetch` fallback was used.
See [the final integration runbook](12-chatgpt-project.md) for remaining acceptance.
