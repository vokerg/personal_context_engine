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

The initial Fastify API serves only `/health`, `/ready` and `/api/v1` (version marker).
**No note, ledger, reminder or other private resource routes are registered.**
Authenticated browsing is blocked on #13. Issue #8 now wires a trusted
Prisma-backed dependency probe: a configured but unavailable PostgreSQL database
fails API startup, while a dependency outage after startup causes `/ready` to
return generic HTTP 503. No private note routes are enabled by this probe.

The skeleton disables request logging, does not trust forwarding headers, limits
JSON bodies to 16 KiB, responds without caching, and defaults to loopback binding.
CORS is denied by default; `API_CORS_ORIGIN` may allow one exact HTTP(S) origin.
Production non-loopback origins require HTTPS. This is not a complete authentication,
rate-limiting, TLS or deployment hardening implementation. These controls must
precede any private route exposure.
