# 18 — Optional MCP and same-login OAuth (#49)

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

The official SDK client is tested against the real local HTTP listener. Remote
HTTPS deployment and a live ChatGPT connector have **not** been verified. This
is a local implementation milestone, not completion of #49's remote acceptance
or #50's retrieval cutover. Keep private GitHub capture and repository search
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

Access tokens expire in 15 minutes; refresh rotates both credentials, with the
parent session's seven-day absolute maximum. Logout invalidates every derived
grant. Only token/code digests persist. The existing 12-hour session idle limit
also bounds grants. Expired session/code rows may be maintained by a future
retention job; they never authorize access after expiry.

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
