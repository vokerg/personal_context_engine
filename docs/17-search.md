# 17 — Gated local DB search (#48)

## Running it

Select the explicit single-user session mode from D-021 and set
`PCE_DB_SEARCH=true`. In `dev:local` this also enables the existing bounded
browse UI. Type into **Ask or search your notes**. Empty search stays on the
existing timeline; a query calls the authenticated POST search route. Results
open full owner-scoped DB originals, including API-only notes outside the
checkout. Source notes are never edited or exported by retrieval.

Keyword search is available without OpenAI. Semantic query processing additionally
requires the existing explicit embedding enablement plus egress sentinel,
server credentials and current READY indexed chunks. The owner separately
approved bounded local indexing/query tests on 2026-10-20; this is not automatic
hosted operation or a default ChatGPT connector cutover.

## Retrieval contract

`POST /api/v1/search` accepts a query (1–500 characters), observed tags, project,
kind, offset-bearing start/end capture instants, limit (1–50) and optional cursor.
The server obtains owner only from a verified session/grant; unknown fields are
rejected. Cookie requests require session-bound CSRF. Queries stay out of URLs,
logs, shared links and browser storage.

PostgreSQL `simple` full-text ranking matches query terms, with literal substring
support for punctuation/identifiers. Exact current-owner/model/chunker/revision
1536-dimensional vectors provide cosine candidates (distance <0.85); reciprocal
rank fusion uses k=60 and deduplicates per note. Each branch considers at most
200 candidates and the response pages the first 200 fused notes. This bounded
window is disclosed by `truncated`; refine filters to explore more. Vector
scoring is exact, not an approximate nearest-neighbor rollout. Further index/load
optimization requires representative corpus measurements; no production SLO
or automatic retrieval cutover is claimed.

Current model is `text-embedding-3-small`, 1536 dimensions, with the same chunker
version as indexing. Missing/obsolete/changed-source vectors cannot contribute.
All lexical/vector/note-detail queries apply the owner predicate inside SQL.
Original snippets are plain text (up to 240 Unicode characters), accompanied by
resolvable note IDs, source revision, capture instant and API/GitHub channel.
No GitHub link is invented for API-only data.

Cursors are process-key HMAC authenticated and bind verified owner, query,
filters, page size, model/version, ranking snapshot and five-minute expiry.
Changes/restart invalidate them with generic 400 and the UI restarts the query.
Queries with unknown dates need no date inference. Exact lexical matches remain
available during missing index, provider failure, malformed vectors or budget
exhaustion; failure never changes a capture original or implies GitHub coverage.

## Cost, latency and checks

Query embeddings have a five-second HTTPS deadline, no redirects and bounded
input. SQL has a two-second statement timeout. Per-owner query rate is at most
four uncached requests/minute per API process. Indexing and queries share the
atomic, durable 60,000-token UTC-day reservation ledger; no refund is made for
uncertain/failed calls. Reserve input UTF-8 bytes +16 as a conservative token
upper bound, capped at 8,192; response usage is checked against this bound.
Indexing still limits four claims per 60-second window and four requests/pass.
A 128-entry, five-minute owner/query-bound vector cache avoids repeated requests
on paging. Real provider/account charges from other clients are outside this
application gate. This limit is below the owner's approved $0.10 local test cap
at the current model price; no extra credit purchase or auto-reload is enabled.

Synthetic PostgreSQL tests cover a Russian no-shared-word invoice/payment case,
lexical/vector fusion, source fidelity, filters/date-unknown requests, owner
isolation, signed pagination, obsolete models, budget/provider fallback and
HTTP authorization. Provider/typed-client tests use fake HTTP only. Real local
provider checks use trusted secrets outside CI and publish no private corpus,
queries, note IDs, project identifiers or response bodies. Actual ChatGPT
connector baseline/cutover acceptance remains #50; it is not inferred from
these deterministic cases.

If MCP is enabled, disable `PCE_MCP_ENABLED` first because its tools require DB
search. Disable `PCE_DB_SEARCH` and restart to restore the prior reader/routes/UI. Clearing
embedding enablement retains keyword search. No destructive schema rollback or
content change is needed.

A bounded live synthetic Russian payment/invoice probe measured cosine 0.274
for the relevant source and 0.063 for an unrelated beach note. The initial
0.35-cosine cutoff excluded that relevant paraphrase; the local gate uses
0.15 cosine instead and regression-tests this range. This small probe is not a
representative relevance benchmark; owner acceptance remains part of #50.

## Opt-in search diagnostics (#97)

Set `PCE_SEARCH_DIAGNOSTICS=true` in the trusted API environment (or the local
root `.env`) and restart the runtime. Default is off: `diagnose_search` is absent
from MCP discovery and cannot be called. Existing `PCE_DB_SEARCH`, MCP/OAuth and
session configuration are still required; this flag does not enable provider
egress, indexing or a retrieval cutover. Hosted environment changes/deployment
are a separate operator step.

Call through an authenticated `notes:read` MCP grant:

```json
{"name":"diagnose_search","arguments":{"query":"home internet","noteId":"11111111-1111-4111-8111-111111111111","limit":5}}
```

`query` is 1–500 characters, `noteId` is optional, and `limit` is 1–20 (default 5).
There are no caller-selected owners, filters or cursors. Diagnostics describe an
unfiltered search and its first `limit` results. The response is JSON text and
MCP `structuredContent` with these fields:

- `index`: owner-only note coverage and chunk/job status counts. `indexedNotes`
  requires at least one current, compatible READY vector. `fullyIndexedNotes`
  requires all existing current chunks to have such vectors; it does not prove
  that every intended section was prepared. `readyChunks` counts distinct
  searchable chunks. `missingNotes` counts notes with no current chunks (including
  stale-only notes); `missingEmbeddings` counts current chunks without a compatible
  embedding record. Stale/incompatible/status counts can overlap and are not a
  mutually exclusive partition of notes. `missingVectors` detects READY records
  without a vector; current database constraints normally prevent this state.
- `execution`: mode, degradation, configured provider, model/dimensions/chunker,
  lexical configuration/operator, strict cosine threshold and RRF/candidate limits.
  `disabled`, `unindexed`, `budget_exhausted` and `provider_unavailable` retain the
  production fallback meanings. `degradationReason` distinguishes the request-rate
  window, daily token ceiling, provider failure and semantic SQL failure;
  `embeddingSource` distinguishes cached/provider/not-executed query embeddings.
  A configured provider is not proof it succeeded.
- `candidates`: the union of top final, lexical and semantic notes, up to three
  highest-scoring below-threshold notes, and the requested note (at most
  `3*limit+4` rows). Scores are **maximum chunk cosine per note**, not confidence.
  `passedThreshold` is null if no eligible vector was scored. Lexical and semantic
  ranks are the production top-200 lists. `rrfScore` sums `1/(60+rank)` for each
  matching list, independently of cosine magnitude. `finalRank` uses production
  date/ID tie breaks; `included` describes the requested first page, bounded by
  the 200-result window. The semantic flag alone never means human relevance.
- `note`: owner-scoped revision and chunk counts, at most 20 chunk/embedding
  metadata rows (with truncation flag and eligible-chunk cosine), best score/ranks
  and separate overall/semantic reasons. `no_chunks`, `stale_chunks`,
  `no_current_ready_embedding`, `semantic_not_executed`,
  `below_similarity_threshold` and candidate/result-window reasons distinguish
  failures. Unknown and other-owner IDs both return `status: not_found`.

The tool uses the same provider approval, query cache, four-request/minute window
and durable 60,000-token/day reservation as search. It can consume approved query
embedding egress and budget; it never prepares chunks, retries jobs, reindexes or
changes notes. Budget reservation is the only diagnostic-related database write.
All inspection queries run in an owner-scoped repeatable-read, read-only
transaction with a two-second statement timeout and an eight-second transaction
limit. Responses omit query text, note bodies, titles, vectors, credentials and
provider exception details. Query/source text must not be logged.

Production threshold and RRF behavior are unchanged. Diagnose coverage first;
then evaluate a labeled multilingual query set before changing thresholds,
lexical stemming or ranking. A missing vector has no measurable stored cosine:
report null rather than interpreting it as a low score or silently indexing it.
