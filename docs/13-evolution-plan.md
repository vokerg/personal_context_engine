# 13 — Progressive evolution: optional GitHub ingress, PostgreSQL workers, MCP and UX

**Date:** 2026-10-16; **revised:** 2026-10-21. **Status:** accepted target / roadmap with the explicitly gated local milestone below; not proof of hosted services. Supersedes the mandatory dual-store direction in the previous version.
Parent implementation epic: [#42](https://github.com/vokerg/personal_context_engine/issues/42).
Authority: [intent](../INTENT.md), [decisions](11-decisions.md), [security](09-security-and-privacy.md).
This document describes contracts and gates for future PRs; it does **not** alter the current Markdown v1 parser, Prisma schema, API, worker or ChatGPT configuration.

## Implemented local milestone (2026-10-20)

Single-user sessions and scoped grants (#44), transactional DB-first API capture
and preparation jobs (#45), bounded embedding workers (#46/#47), and gated
owner-scoped web/API lexical/hybrid search (#48) are implemented and tested.
The optional MCP/OAuth adapter (#49) shares that login and passes official-client
loopback tests. Hosted HTTPS and live ChatGPT connector/cutover acceptance
remain open (#49/#50). GitHub capture/search stays available. See
[search runbook](17-search.md) and [MCP runbook](18-mcp.md).

## ChatGPT Project capture UX bridge (D-024)

**Accepted owner requirement (2026-10-21, #95):** Treat the ChatGPT GitHub
connector as a temporary, easily unplugged **product integration workaround**,
not as core PCE architecture. The existing `NOTES` Project workflow is to
open the Project, dictate/type a thought and send without per-message app
selection. Its instructions write Markdown v1 to the private GitHub inbox.
Preserve this low-friction experience, provenance and idempotent importer while
native PCE API/MCP capture is tested in the actual Project surface.

Project instructions may *request* Personal Context Engine tool use when
available, but they do not grant access or permanently attach MCP tools. A
working remote `capture_note` action does **not** imply that ChatGPT will
choose it automatically for every Project message. Requiring `@Personal Context
Engine` or repeated `+` tool selection for routine text/voice memos is a
product-UX regression and **not** a valid automatic cutover. Gate retirement
on owner-observed fresh-chat and successive-message voice/text capture with no
mandatory explicit tool selection; verify confirmed DB persistence, duplicate
avoidance, auth/consent friction, failed writes and recovery. Maintain the
GitHub path as a switchable fallback until these pass. Do not infer the full
synthetic matrix in #12 has already passed from observed routine usage.

A future optional export of *only approved taxonomy context* from DB to the
private repository would be a **separate** bounded, versioned, feature-gated,
one-way compatibility adapter; not general two-way note synchronization. The
worker's normal DB jobs, capture and search must not depend on that export.
The removable exporter is an accepted temporary design direction (#100), **not an implemented feature**; installation and final ChatGPT prompt review remain gated by #105.
See [D-024](11-decisions.md#d-024--temporary-github-connector-capture-ux-bridge).

## Accepted feature lanes: tags, ordinary research and final prompt (D-025/D-026)

**Decided 2026-10-21; design/implementation issues remain open.** Postgres is
the authoritative operational store. The temporary ChatGPT GitHub connector
is a removable capture-UX workaround under D-024. No new general DB-to-GitHub
replication path is authorized.

| Sequence | Issue | Intended behavior |
| --- | --- | --- |
| 1 | #99 | Owner-scoped approved-tag registry; raw per-note tags remain candidates unless already approved; zero tags valid; activity chips are the approval control and approved global chips remain filters |
| 2 | #103 | Manual attach/detach tags to a specific note in the DB via effective-tag overrides; retain immutable GitHub original and reflect effective tags in filters/search |
| 3 | #100 | Optional approved-tag-only private GitHub snapshot, exported by an **additional durable job handler in the existing worker** (not a new service), coalesced/hash-deduplicated, removable by flag; implement private repo guidance |
| 4 | #104 | **Ordinary interactive ChatGPT research** only when directly requested; MUST use PCE MCP search/read for related notes, optionally ordinary web research, persist a separate sourced/versioned ResearchReport via private GitHub ingress and DB; existing worker imports/indexes, never researches; implement private repo contract |
| **Last** | **#105** | Only after preceding features are implemented: reconcile private repo instructions and produce/test a **single final NOTES Project prompt**; user manually installs it; preserve current ordinary memo UX |

PCE MCP `search_context` plus `get_note` are required for context-grounded
research; a successful no-hit search is okay, but unavailable MCP makes the
report explicitly incomplete. The ChatGPT Project prompt cannot guarantee
MCP availability/selection. **No special Deep Research feature is required.**
Stored reports link a newly captured Note to actually retrieved context note
IDs and external citation URLs, keeping model-generated content separate from
the user's original words. See [research contract plan](20-research-capture.md).

## Baseline that must not break

The owner already uses ChatGPT with a private GitHub content repository to capture/read notes. Existing code has Markdown v1 parsing, a private-repo GitHub adapter, an opt-in deterministic ingestion worker, PostgreSQL projections, and a **local-development** owner-scoped read path. Runtime availability, continuous hosted ingestion and all connector permissions require separate verification; never assume a live deployed production worker, hosted MCP, embeddings, AI summaries or push notifications exist.

For now:
```text
ChatGPT + GitHub connector ---write/read/search---> PRIVATE content repo
                                         |
                       opt-in ingestion worker (existing)
                                         |
                                  PostgreSQL notes
```

Keep repo-based ChatGPT search **as the current default** until PostgreSQL retrieval is independently verified and explicitly approved. GitHub files remain a useful input archive and fallback **for GitHub-origin records only**, not a backup of API-origin captures or derived data.

## Accepted target: two independent inputs, one operational store

```text
A. Existing independent capture:  ChatGPT -> private GitHub inbox -> importer -> PostgreSQL
B. Opt-in local direct capture:        ChatGPT -> token MCP / API -----------> PostgreSQL
C. Work after durable import:                                         DB jobs -> workers -> DB
D. Read NOW:                    ChatGPT -> existing private GitHub connector
E. Read LATER, gated:           ChatGPT -> scoped MCP -> DB search API -> PostgreSQL
```

**GitHub input (A):** retain the existing Markdown v1 source bytes, stable note/capture IDs and provenance. A GitHub write can succeed without an active PCE service. The ingestion adapter validates and transactionally stores originals/owner/source revision in PostgreSQL, idempotently enqueues downstream work and checkpoints the imported Git revision only after success. Poll/reconcile from a durable cursor and periodically rescan relevant source paths after service outage, webhook loss, restarts or revisions; use conservative conflict handling instead of silently replacing imported originals. Expose GitHub-ingested vs DB-persisted status and lag. The **currently implemented** GitHub worker still finalizes/moves files to `notes/YYYY/MM/`; removing its Git write requirement is a separate tested migration (#43), not part of this docs PR.

**API/MCP input (B):** authenticate and verify owner/scope, validate and store the versioned original and note(s) **in one PostgreSQL transaction**, with stable IDs, an idempotency key, source attribution and durable downstream DB jobs. An acknowledgement means **DB persisted**, with downstream indexing/aggregates pending as appropriate. GitHub export and a GitHub replication outbox are **not required**; do not issue a second client write. Direct capture naturally fails safely when API/DB is unavailable—do not imply it works offline.

**Worker boundary (C):** after either ingress, workers claim DB jobs with leases/retries, read authenticated/owner-scoped DB originals, and persist embeddings, tags, links, sourced evidence/ledgers and processing statuses back to DB. The repo is never a worker processing queue nor a sink for generated aggregates. Embedding/model outages must not undo capture.

**Recovery and ownership:** PostgreSQL is the accepted authoritative operational store, including API-origin originals that never appeared in GitHub; backup/PITR/export automation (#61) is deferred to later or manual operation by owner decision D-020 (2026-10-18), and is not a prerequisite for functional delivery. The existing synthetic restore drill is optional. Preserve GitHub source revisions as import provenance rather than syncing independently editable copies. Historical D-004 projection/file-finalization semantics describe code still running today, but D-019 supersedes them **for the target**, not by fiat in deployed code. Deletion/edit conflict policy and opt-in exports require separately reviewed decisions.

**Auth/identity:** current local `ownerSubject` is not production multi-user identity. Before public direct writes, define account mapping, token lifecycle and SQL owner isolation. Legacy/unowned records must not be automatically claimed.

## Embeddings: optional asynchronous enrichment

- **Initial provider:** OpenAI `text-embedding-3-small` with server-held credentials and a replaceable `EmbeddingProvider` adapter. Default 1536-dimensional vectors (confirm the chosen dimension contract before migration); no server-side ChatGPT subscription entitlement.
- Add `note_chunks` with owner, note ID, content revision/hash, chunk ordinal/boundaries, normalized text and stable chunking-version, plus versioned embedding/model ID, vector dimension, index status, retry lease and last error code. Design indexes and migrations for the actual PostgreSQL hosting capability to enable `pgvector`.
- Chunk and hash deterministically; avoid duplicate embeddings on repeated imports. Enqueue after a durable note commit; the embeddings worker consumes pending jobs asynchronously, sends a bounded private-text payload, verifies output vector size, upserts vectors and records processing/cost. Backfill and model upgrades must be resumable.
- Bound batch size, token count, 429/5xx retry, concurrency, per-user budget, provider outage and cost. Explicitly disclose that selected note text leaves the PCE host for OpenAI processing; let operators disable embeddings. This is an integration/hosting privacy decision, not something implied by a local-only worker.
- Embeddings are derived indexes, **never** the source of facts. GitHub-origin captures can still be written to the repo while PCE is unavailable; PostgreSQL search and direct API-origin capture require the service. Lexical DB search continues to work when embeddings are disabled.

## Retrieval: repository now, hybrid DB later

**Now:** ChatGPT searches the private content repository using its existing supported GitHub integration. It may read originals and inspect matching notes. We do not claim that an MCP `search_context` tool or DB semantic search already works.

**Parallel development:** An owner-scoped API receives text, date/project/type/tag filters, limit and cursor. Compute a query embedding with the same configured model/version used for note chunks; run PostgreSQL full-text/lexical matches plus pgvector cosine-nearest chunks; fuse/rerank candidates and return bounded snippets, source IDs/revisions, links, and ranked evidence. For queries such as *"Какие были оплаты?"*, find a note saying *"закрыть инвойс"* even without lexical overlap. Include exact named-entity and date matches for finance-like recall, and don't conflate a proposed expense with confirmed payment.

**Search switch gate:** evaluate Russian and multilingual no-shared-word prompts against the existing private repo search; enforce cross-user isolation inside the database and test prompt-injection-resistant returned content. Only then enable DB results for opted-in MCP clients, retain an easy rollback and explicitly approve any default switch. Safe lexical-only fallback applies to unindexed notes; an embedding outage cannot make the archive vanish.

## Tokenized app/MCP trust boundary

Keep all clients, including ChatGPT, away from raw PostgreSQL URLs, GitHub write tokens and OpenAI API keys. The optional MCP adapter is locally implemented; hosted use requires HTTPS and verification with the actual supported ChatGPT client. D-021/D-022 select same-login authorization-code + S256 PKCE, short-lived opaque DB-verified audience-bound grants, rotating refresh/revocation and scopes `capture:write` / `notes:read` for the current single-user mode. Issuer and owner are bound through the live server session, not caller parameters. The legacy JWT verifier remains a separate boundary; opaque grants are not falsely described as signed JWTs. Ledger scopes and multi-user onboarding are not implemented.

Proposed tools: `capture_note` for versioned content + idempotency (reports confirmed DB persistence and independent downstream job states, never a GitHub export promise); `get_note` for authorized source/detail; `search_context` for gated retrieval; `get_ledger_evidence` for bounded period facts. Avoid claiming that arbitrary preceding ChatGPT messages or full history are automatically provided to a plugin. The old, closed experimental MCP PR #31 must not be merged as a shortcut without reviewing new identity and DB-primary contracts.

## Ledgers and reasoning ownership

The deterministic worker derives facts: note references, period windows, tags, accepted status transitions, stale flags, and evidence pack IDs. **ChatGPT is the initial interactive narrative/analysis engine**, invoking the tools or inspecting the repo. Its narrative is sourced to notes and may be reviewed before persistence. OpenAI embeddings are only for retrieval, not ledger text generation. A hosted DeepSeek adapter, model selection, scheduled AI generation and automated costs are all deferred decisions. No synthesized action/reminder is auto-approved.

## Web UX and tag taxonomy

Build a meaningful responsive web surface around the note timeline, calendar-day grouping, full original detail, clear loading/error/empty states, search/filter, source provenance and ingestion status. The current prototype is not the target UI.

Provide a tenant-scoped API listing the distinct tags **actually present** in saved notes, with counts; show one prominent set of approved tag-filter chips in the note browser (without a duplicate vocabulary catalog, registry revision, or GitHub export diagnostics on that screen). An optional full registry directory belongs in a separate management flow if needed; retain its backend even while absent from the primary timeline. Support combinable tag/project/type/date filters, predictable back/reset and keyboard accessibility. Present notes as visually separated entries and offer system/light/dark appearance, storing only a non-sensitive display preference in the browser. These are **descriptive user-authored tags**. Do not enforce a predefined taxonomy, delete aliases or silently rename original metadata. A canonical/default tag model, aliases, suggestions and per-user overrides are a separate product exploration (#54).

## Delivery order and gates

| Lane | Dependency order | Go/no-go evidence |
| --- | --- | --- |
| Existing channel | [#43](https://github.com/vokerg/personal_context_engine/issues/43), follow [#12](https://github.com/vokerg/personal_context_engine/issues/12) connector experiment | Safe GitHub import/DB visibility; capture and repo search still function |
| Auth/DB-first capture | [#44](https://github.com/vokerg/personal_context_engine/issues/44) -> [#45](https://github.com/vokerg/personal_context_engine/issues/45) | Real token ownership, idempotent DB capture, durable DB jobs; no mandatory GitHub export |
| Embeddings/search | [#46](https://github.com/vokerg/personal_context_engine/issues/46) -> [#47](https://github.com/vokerg/personal_context_engine/issues/47) -> [#48](https://github.com/vokerg/personal_context_engine/issues/48) | Indexed source fidelity, reasonable limits, multilingual recall, user isolation |
| ChatGPT interoperability | [#49](https://github.com/vokerg/personal_context_engine/issues/49) -> [#50](https://github.com/vokerg/personal_context_engine/issues/50) | MCP auth/tool calls proven; repo-first search remains active |
| Web/tag experience | [#51](https://github.com/vokerg/personal_context_engine/issues/51) -> [#52](https://github.com/vokerg/personal_context_engine/issues/52) -> [#53](https://github.com/vokerg/personal_context_engine/issues/53) | Usable browsing and clickable existing tag filters; [#54](https://github.com/vokerg/personal_context_engine/issues/54) taxonomy deferred |
| Intelligence and acceptance | [#55](https://github.com/vokerg/personal_context_engine/issues/55) DB ledgers; [#56](https://github.com/vokerg/personal_context_engine/issues/56) rollout; [#61](https://github.com/vokerg/personal_context_engine/issues/61) recovery deferred (D-020) | Source-linked results, no silent loss/duplication or forced cutover; backups are not a delivery gate |

Workstreams can overlap only where dependencies and file ownership allow. Every implementation requires a separate issue PR and synthetic CI; trusted integration/provider testing happens with properly provisioned private credentials **outside public PR CI**. No production automatic deployment, DeepSeek generation, push delivery, MCP server or embeddings index is delivered by this document.

### Provisioning prerequisite (#58)

[OpenAI setup](14-openai-setup.md) prepares a dedicated development project,
restricted expiring key and local diagnostic without sending any private
chunks. It can proceed before #46 because it adds no vector schema or job
execution. It does not complete #47, authorize egress or change the active
capture/search path. Keep provider processing disabled until those gates pass.
