# 13 — ChatGPT custom MCP app: save chat context

**Status:** implementation candidate, issue [#28](https://github.com/vokerg/personal_context_engine/issues/28). Source code and synthetic tests are in `apps/worker/src/chatgpt-mcp/`; **not deployed, connected to ChatGPT, or tested against a real OAuth provider/private content repository**. It is an independently started MCP process; the normal worker remains unchanged.

## User workflow

1. In a current ChatGPT conversation, explicitly invoke the connected **Personal Context Engine** custom plugin and ask it to save either a *brief* or *full* context note.
2. Review the title, summary and exact source text ChatGPT proposes to send. Only approve material you want stored in Git history.
3. For `brief`, provide or select a **verbatim source excerpt** and a faithful summary. The record explicitly says it is *not* a complete chat transcript and sets `review_required: true`.
4. For `full`, supply an actual complete transcript and explicitly confirm that it is complete. The MCP tool rejects the mode unless `full_transcript_confirmed: true`. This flag is a user-consent assertion, **not an independent ChatGPT transcript verification**. If there is no complete transcript available, use `brief` or export/paste the conversation manually.
5. When the write tool reports `created` or `already_saved`, find a schema-v1 Markdown memo in the **private** content repo's `inbox/`; the normal ingestion worker is a separate concern. A note is **not** a reminder or background automation.

**Critical limitation:** MCP plugins do not automatically gain permission to read arbitrary conversations, hidden messages or full ChatGPT history. The assistant provides the arguments it can legitimately see in the active context; it must not fill gaps by inventing message text. There is no claim of a native "attach entire past chat" button.

## Transport and security

- Stateless Streamable HTTP JSON-RPC endpoint `POST /mcp` with `initialize`, `tools/list`, `tools/call`, `ping` and notifications. Readiness endpoint: `GET /health`; OAuth discovery: `/.well-known/oauth-protected-resource`.
- Tool `save_chat_context` advertises OAuth `pce.capture` scope, non-read-only and idempotent annotations. No custom UI or unrelated tools.
- `tools/call` **always** verifies the OAuth Bearer token using trusted issuer JWKS (RS256), exact issuer, audience, expiry, optional not-before, required scope, and the configured **single owner subject**. No credentials or user identity are accepted as tool arguments. The auth server itself must be provided by an established OAuth 2.1 identity provider; this code is a protected resource server, not an OAuth login server.
- External HTTPS with OAuth authorization-code + PKCE, correct resource metadata and audience is required before connecting it to ChatGPT. The Node HTTP listener binds **loopback only** and requires an HTTPS reverse proxy. Protect the proxy with limits, TLS and appropriate rate limits. Do not expose loopback HTTP publicly or embed tokens in a public URL.
- The writer requires GitHub credentials on the **server only**; on every call it confirms `private: true` for the configured content repository, then uses a branch-head compare-and-swap commit. It writes only canonical `inbox/YYYY-MM-DD_<id>.md` Markdown; existing note IDs across `inbox/` or processed `notes/` are verified before acknowledging idempotent replay. A reused request UUID with different contents is a conflict, never an overwrite. All errors and logs omit note contents and secrets.
- The MCP tool caps incoming JSON and source bytes, refuses incomplete/invalid v1 notes, never guesses due dates or performs additional actions. Git history persists deleted/changed content: store only material you intend to retain.
- Use a unique `request_id` UUID per explicit save, **and reuse that UUID on retries**. Changing it intentionally creates a new capture.

## Local commands

From root (Node 22.12+ / npm 10+):

```sh
npm ci
npm run build -w @pce/core
npm run dev:mcp -w @pce/worker
```

Configure the following **only in a trusted local secret store / process environment**, never in a source file or `.env` committed to Git:

| Variable | Purpose |
| --- | --- |
| `CONTENT_REPOSITORY` | The separately verified **private** owner/repo, e.g. `vokerg/personal_context_engine_content` |
| `CONTENT_BRANCH` | Selected existing branch, e.g. `main` |
| `CONTENT_GITHUB_TOKEN` | Server-only GitHub token scoped to that private repository (Contents write, Metadata read) |
| `PCE_MCP_RESOURCE_URL` | Externally visible HTTPS MCP URL ending `/mcp` (audience/resource) |
| `PCE_MCP_OAUTH_ISSUER` | HTTPS issuer URL in validated JWTs |
| `PCE_MCP_OAUTH_AUDIENCE` | Exact audience value expected in OAuth access tokens |
| `PCE_MCP_OAUTH_JWKS_URL` | HTTPS JWKS endpoint for RS256 verification |
| `PCE_MCP_OWNER_SUB` | Exact allowlisted immutable owner `sub` claim |
| `PCE_MCP_PORT` | Optional loopback port, default `8787` |
| `PCE_MCP_HOST` | Optional loopback interface, default `127.0.0.1` |

A development or hosted IdP must issue access tokens to this MCP resource with `scope: pce.capture`, the exact `aud`, an allowlisted `sub`, and RS256 signatures discoverable at the configured JWKS URL. Confirm your provider supports ChatGPT's OAuth client registration and authorization-code PKCE flow. A regular GitHub personal access token is **not** a substitute for an OAuth identity token. Do not enable anonymous access or pass a custom static key to ChatGPT.

To inspect the MCP protocol, run `npx @modelcontextprotocol/inspector` and connect via Streamable HTTP to a trusted local endpoint. The write operation should **not** work without a valid owner token. Test with entirely synthetic note text and a disposable **private** test repository before any real content. Public PR CI cannot test live authentication, hosting, GitHub permissions or ChatGPT installation.

## Failure and recovery

- No authenticated token / wrong subject/scope/issuer/audience → auth challenge, **no write**.
- No complete transcript confirmation, unfaithful/blank/oversized input or invalid schema → explicit not-saved result; user can revise and retry.
- Public/archived repository or missing GitHub permission → **no write**.
- GitHub commit conflict → bounded compare-and-swap retries; duplicate note ID with identical content is acknowledged, differing content rejected. Unexpected network/JSON/GitHub errors are sanitized.
- A crash after GitHub commit but before the MCP reply can be safely retried using the **same UUID**, even if the worker moved the note from inbox into notes. If the worker has deleted it or made it unavailable, recovery may require inspecting private repository history.

## Verification checklist

- Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run docs:check` (record actual results; do not assume CI is complete).
- Local transport inspection: `initialize`, list tool schemas, try anonymous save (must fail), bad/full-unconfirmed save (must fail), signed owner save (synthetic data) and retry.
- ChatGPT configuration requires *a live HTTPS endpoint and OAuth provider setup*; review write confirmation and data disclosure prompts in the actual target ChatGPT account. The implementation alone does not install a ChatGPT plugin automatically.

See [capture contract](04-capture-contract.md), [ChatGPT Project guidance](12-chatgpt-project.md) and [security](09-security-and-privacy.md).
