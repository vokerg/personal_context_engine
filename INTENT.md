# PCE — Current product and delivery intent

**Recorded:** 2026-10-16; **revised:** 2026-10-20. **Status:** accepted target direction, not proof of deployed services.
**Implementation epic:** [#42](https://github.com/vokerg/personal_context_engine/issues/42); [evolution plan](docs/13-evolution-plan.md); [decision D-019](docs/11-decisions.md).

## Product purpose

Make conversations and voice notes into durable personal context that can be **found, inspected, summarized and deliberately acted upon**. ChatGPT is the initial interactive capture/reasoning surface, not the permanent data store or sole identity provider. Users need not remember the original date, tag or wording.

## What works now — do not break

- Existing ChatGPT -> private GitHub capture and repository search/read work in the user's current supported connector surface. The repository can accept input when PCE is down; DB import resumes only after the ingestion service runs.
- Markdown v1 GitHub ContentStore and the opt-in deterministic worker **currently finalize/move GitHub files** and import their content into a PostgreSQL **projection**. This implementation remains until an issue-backed migration changes and tests it.
- An opt-in local owner-aware browser exists. Production identity, always-on hosted workers, remote MCP, embeddings, automatic ledgers and notifications are **not** implied by this plan.

## Implemented local milestone — 2026-10-20

Explicit feature gates now provide single-user sessions (#44), DB-first API
capture/idempotency/jobs (#45), bounded embedding preparation/provider passes
(#46/#47), and owner-scoped lexical/hybrid web/API retrieval (#48). Optional
same-login OAuth PKCE and MCP tools (#49) are tested with the official client on
loopback. These mechanisms do not prove hosted HTTPS/ChatGPT acceptance or
activate a repository-search cutover. Automatic ledgers, notifications and
hosted scheduling remain separate. See [search operations](docs/17-search.md)
and [MCP status](docs/18-mcp.md) for actual configuration and checks.

## Accepted target — two ingress paths, one operational database

1. **Independent input channels:** private GitHub Markdown is an optional, durable inbox; token-authenticated API/MCP is an independent direct capture channel. Using one does not require the other.
2. **PostgreSQL authority:** original input, owner and source provenance, stable capture/note IDs, revisions, tags, reminders, indexes, embeddings, sourced aggregates/ledgers, job state and processing history persist in the DB. API/MCP capture acknowledges a durable DB commit, **not** successful GitHub mirroring.
3. **Ingestion:** the GitHub adapter validates and transactionally imports its inputs to PostgreSQL and records durable revision/checkpoint state. It periodically reconciles after missed webhooks, outages, restarts or source revisions, without duplicating or silently overwriting notes.
4. **Workers:** after either ingress, processing uses **database jobs** and writes derived results **back to PostgreSQL**. Github is not a worker queue or required destination for tags, ledger artifacts or embeddings. Downstream/model failure never invalidates successfully captured original input.
5. **No mandatory reverse sync:** API/MCP-origin notes and worker-derived results are not automatically exported to GitHub. Portable export/backup can be a separate explicit feature. GitHub retains its previously written Markdown/history, but is not a full backup of API-origin data.
6. **Retrieval:** owner-scoped DB lexical/hybrid search is the future canonical read path. Keep today's ChatGPT GitHub-based search as default/fallback until a measured, authorized and approved opt-in cutover. MCP remains optional and is never required for GitHub capture.
7. **Intelligence and UX:** separately authorized OpenAI `text-embedding-3-small` indexing, DB-generated sourced evidence, interactive ChatGPT narrative, web timeline and clickable observed tags. DeepSeek, unattended LLM generation and canonical taxonomy are deferred.

## Non-negotiables

- Preserve original source bytes/meaning, offset-bearing timestamps, stable IDs, ownership and revisions; derived output cites resolvable source IDs and never creates external actions by itself.
- Distinguish GitHub input accepted from DB imported; distinguish API-origin DB persisted from downstream processing pending. Do not claim DB capture works if API/database is down.
- Keep tenant isolation in DB queries, verify tokens, protect source/private content and never send credentials or real user notes through public CI. External provider processing requires disclosed consent and cost limits.
- **Owner decision D-020 (2026-10-18): backups are deferred** (#61), to be handled later or manually. Backup/PITR/export automation is not a gate for current functional development or getting the project running. Keep the optional synthetic restore drill; do not claim that production backups are configured. GitHub cannot recover API-only records.
- Keep a reversible implementation migration and explicit approval for default search changes.

## Not yet implemented or separately approved

Change of legacy GitHub finalization to read-only ingestion, hosted deployment/scheduling, production authentication/MCP, embeddings and hybrid search, optional export, rich editing/conflict/deletion policy, unattended notifications and a default ChatGPT retrieval cutover all have separate gates. An architectural decision is not shipped code.

Follow [delivery order and gates](docs/13-evolution-plan.md#delivery-order-and-gates).
