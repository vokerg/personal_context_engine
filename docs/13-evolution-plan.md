# 13 — Progressive evolution: dual-store capture, embeddings, token MCP and UX

**Date:** 2026-10-16. **Status:** roadmap / accepted product direction, **not** implemented services.
Parent implementation epic: [#42](https://github.com/vokerg/personal_context_engine/issues/42).
Authority: [intent](../INTENT.md), [decisions](11-decisions.md), [security](09-security-and-privacy.md).
This document describes contracts and gates for future PRs; it does **not** alter the current Markdown v1 parser, Prisma schema, API, worker or ChatGPT configuration.

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

Keep repo-based ChatGPT search **as the default** while designing other ways to retrieve context. Private Markdown remains useful for export, review, backup and rollback.

## Future coexistence: two capture origins, two destinations

```text
A. Existing GitHub-origin capture:  ChatGPT -> GitHub inbox -> worker -> PostgreSQL
B. Future tokenized capture:       ChatGPT -> MCP -> PCE API -> PostgreSQL
                                                           -> DB export outbox -> GitHub
C. Search NOW:                     ChatGPT -> existing GitHub connector
D. Search LATER, gated:            ChatGPT -> scoped MCP retrieval -> PCE search API -> PostgreSQL
```

**A:** Keep existing Markdown v1, note/capture IDs, original text, validation, compare-and-swap finalization and safe legacy ownership reconciliation. A GitHub file successfully written is not proof it was indexed into PostgreSQL; expose import lag/status separately.

**B:** Do **not** use two independent client HTTP writes. In a single database transaction, validate the versioned capture, persist immutable original text and derived note(s), verified owner, source/content revision, idempotency key, and durable outbox entries for private GitHub export and optional indexing. The export worker performs create-only or explicit revision-checked file commits, records GitHub path/revision, retries transient failures, and surfaces conflicts for repair. A response may truthfully say **DB persisted; GitHub export pending**. The same ID/content imported back via the existing GitHub worker must reconcile, not duplicate or silently adopt another owner's note. Cross-store atomicity is unavailable; deterministic reconciliation and observability are mandatory.

**Auth/identity:** Existing dev `ownerSubject` is not a multi-user system. Before new public writes, establish an account/subject mapping and owner-scoped storage, API auth and token lifecycle. Legacy unowned records require an explicit owner-approved migration and cannot be claimed by client input.

**Scope of source of truth:** The present GitHub-first D-004 stays effective for GitHub-origin notes. API-origin DB commits will be durable, but the product-wide editable authoritative source and deletion/conflict policy are **not yet changed**. Do not promise bidirectional edits or automatic erasure in Git history.

## Embeddings: optional asynchronous enrichment

- **Initial provider:** OpenAI `text-embedding-3-small` with server-held credentials and a replaceable `EmbeddingProvider` adapter. Default 1536-dimensional vectors (confirm the chosen dimension contract before migration); no server-side ChatGPT subscription entitlement.
- Add `note_chunks` with owner, note ID, content revision/hash, chunk ordinal/boundaries, normalized text and stable chunking-version, plus versioned embedding/model ID, vector dimension, index status, retry lease and last error code. Design indexes and migrations for the actual PostgreSQL hosting capability to enable `pgvector`.
- Chunk and hash deterministically; avoid duplicate embeddings on repeated imports. Enqueue after a durable note commit; the embeddings worker consumes pending jobs asynchronously, sends a bounded private-text payload, verifies output vector size, upserts vectors and records processing/cost. Backfill and model upgrades must be resumable.
- Bound batch size, token count, 429/5xx retry, concurrency, per-user budget, provider outage and cost. Explicitly disclose that selected note text leaves the PCE host for OpenAI processing; let operators disable embeddings. This is an integration/hosting privacy decision, not something implied by a local-only worker.
- Embeddings are derived indexes, **never** the source of facts. Notes must still save and be retrievable by repo or lexical methods when the API is unavailable.

## Retrieval: repository now, hybrid DB later

**Now:** ChatGPT searches the private content repository using its existing supported GitHub integration. It may read originals and inspect matching notes. We do not claim that an MCP `search_context` tool or DB semantic search already works.

**Parallel development:** An owner-scoped API receives text, date/project/type/tag filters, limit and cursor. Compute a query embedding with the same configured model/version used for note chunks; run PostgreSQL full-text/lexical matches plus pgvector cosine-nearest chunks; fuse/rerank candidates and return bounded snippets, source IDs/revisions, links, and ranked evidence. For queries such as *"Какие были оплаты?"*, find a note saying *"закрыть инвойс"* even without lexical overlap. Include exact named-entity and date matches for finance-like recall, and don't conflate a proposed expense with confirmed payment.

**Search switch gate:** evaluate Russian and multilingual no-shared-word prompts against the existing private repo search; enforce cross-user isolation inside the database and test prompt-injection-resistant returned content. Only then enable DB results for opted-in MCP clients, retain an easy rollback and explicitly approve any default switch. Safe lexical-only fallback applies to unindexed notes; an embedding outage cannot make the archive vanish.

## Tokenized app/MCP trust boundary

Keep all clients, including ChatGPT, away from raw PostgreSQL URLs, GitHub write tokens and OpenAI API keys. The future MCP adapter runs at an HTTPS endpoint under the PCE authorization boundary. Configure an approved login/OAuth 2.1 authorization-code + PKCE flow as supported by the actual ChatGPT client, with short-lived, signed, audience-bound tokens, refresh/revocation policy and narrowly scoped permissions such as `captures:write`, `notes:read`, `ledgers:read`. Server verifies issuer, signature, audience, expiry, scopes and derives owner from the verified principal. User IDs submitted in tool arguments have no authority.

Proposed tools: `capture_note` for versioned content + idempotency (reports DB persisted vs pending GitHub export); `get_note` for authorized source/detail; `search_context` for gated retrieval; `get_ledger_evidence` for bounded period facts. Avoid claiming that arbitrary preceding ChatGPT messages or full history are automatically provided to a plugin. The old, closed experimental MCP PR #31 must not be merged as a shortcut without reviewing new identity and dual-store contracts.

## Ledgers and reasoning ownership

The deterministic worker derives facts: note references, period windows, tags, accepted status transitions, stale flags, and evidence pack IDs. **ChatGPT is the initial interactive narrative/analysis engine**, invoking the tools or inspecting the repo. Its narrative is sourced to notes and may be reviewed before persistence. OpenAI embeddings are only for retrieval, not ledger text generation. A hosted DeepSeek adapter, model selection, scheduled AI generation and automated costs are all deferred decisions. No synthesized action/reminder is auto-approved.

## Web UX and tag taxonomy

Build a meaningful responsive web surface around the note timeline, calendar-day grouping, full original detail, clear loading/error/empty states, search/filter, source provenance and ingestion status. The current prototype is not the target UI.

Provide a tenant-scoped API listing the distinct tags **actually present** in saved notes, with counts; show clickable chips and a browsable tag directory, supporting combinable tag/project/type/date filters, predictable back/reset and keyboard accessibility. These are **descriptive user-authored tags**. Do not enforce a predefined taxonomy, delete aliases or silently rename original metadata. A canonical/default tag model, aliases, suggestions and per-user overrides are a separate product exploration (#54).

## Delivery order and gates

| Lane | Dependency order | Go/no-go evidence |
| --- | --- | --- |
| Existing channel | [#43](https://github.com/vokerg/personal_context_engine/issues/43), follow [#12](https://github.com/vokerg/personal_context_engine/issues/12) connector experiment | Safe GitHub import/DB visibility; capture and repo search still function |
| Auth/dual-write | [#44](https://github.com/vokerg/personal_context_engine/issues/44) -> [#45](https://github.com/vokerg/personal_context_engine/issues/45) | Real token ownership and replay-safe export; database vs GitHub statuses truthful |
| Embeddings/search | [#46](https://github.com/vokerg/personal_context_engine/issues/46) -> [#47](https://github.com/vokerg/personal_context_engine/issues/47) -> [#48](https://github.com/vokerg/personal_context_engine/issues/48) | Indexed source fidelity, reasonable limits, multilingual recall, user isolation |
| ChatGPT interoperability | [#49](https://github.com/vokerg/personal_context_engine/issues/49) -> [#50](https://github.com/vokerg/personal_context_engine/issues/50) | MCP auth/tool calls proven; repo-first search remains active |
| Web/tag experience | [#51](https://github.com/vokerg/personal_context_engine/issues/51) -> [#52](https://github.com/vokerg/personal_context_engine/issues/52) -> [#53](https://github.com/vokerg/personal_context_engine/issues/53) | Usable browsing and clickable existing tag filters; [#54](https://github.com/vokerg/personal_context_engine/issues/54) taxonomy deferred |
| Intelligence and acceptance | [#55](https://github.com/vokerg/personal_context_engine/issues/55) ledgers; [#56](https://github.com/vokerg/personal_context_engine/issues/56) migration validation | Source-linked interactive ledger; no silent loss, dupe or forced cutover |

Workstreams can overlap only where dependencies and file ownership allow. Every implementation requires a separate issue PR and synthetic CI; trusted integration/provider testing happens with properly provisioned private credentials **outside public PR CI**. No production automatic deployment, DeepSeek generation, push delivery, MCP server or embeddings index is delivered by this document.
