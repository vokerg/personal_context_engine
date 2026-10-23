# 11 — Architectural decision register

**Baseline date: 2026-10-15.** An accepted decision is a **product direction**, not a claim of implemented software. Revisions should document what changed, why, and the migration impact.

## Accepted decisions

| ID | Decision | Rationale |
| --- | --- | --- |
| D-001 | Separate **public mechanism** (`vokerg/personal_context_engine`) and **private personal content** (`vokerg/personal_context_engine_content`). | Independent permissions, public CI, open-source potential. |
| D-002 | ChatGPT Project is the first capture and interactive aggregation interface, but replaceable. | Low-friction voice entry, portability. |
| D-003 | Versioned Markdown with structured frontmatter is the ingestion interchange format. | Human readability, LLM friendliness and portability. |
| D-004 | **Historical / currently implemented:** Markdown is the first-stage source of truth for GitHub-origin imports and PostgreSQL is a projection. **Superseded as target by D-019 (2026-10-17).** | Explain existing importer/finalization behavior until migrated, not a future two-store requirement. |
| D-005 | Public web = **React + Vite**; mobile = **React Native + Expo**. | Shared React ecosystem and typed APIs. |
| D-006 | Backend/worker = Node.js + TypeScript; API = Fastify; PostgreSQL/Prisma; npm workspaces. | Aligns with existing development practices. |
| D-007 | Mobile app is required, especially for notifications and browsing; mobile capture is a later extension. | Product reach beyond the chat interface. |
| D-008 | Ledgers: daily, weekly, monthly; per-project ledgers are a natural extension. | Re-surface useful context rather than archive it forever. |
| D-009 | The public repository owns code, schemas and CI; the content repository contains no app CI. | Strong separation of operational responsibilities. |
| D-010 | No external action is executed solely due to a model-assigned tag. | Prevent accidental or unauthorized side effects. |
| D-011 | Non-trivial engineering work is GitHub issue-first, one reviewable PR per issue, with CI evidence and explicit human approval before merging. | Auditability, reproducible agent execution and separation of author from reviewer. |
| D-012 | Interim authenticated API uses strict short-lived HS256 JWTs behind a replaceable verifier, with server-only signing keys and verified-subject scoping. | An auditable zero-external-service boundary for synthetic tests; future hosted OIDC/JWKS and key rotation are explicitly permitted without changing route authorization. |
| D-013 | Keep private GitHub ChatGPT capture and repository search working throughout a **progressive**, reversible evolution. | No interruption to the user's already-useful capture workflow; any default switch requires demonstrated parity and approval. |
| D-014 | **Superseded as target by D-019 (2026-10-17):** former mandatory dual-store destination/GitHub export-outbox plan. | Historical rationale only; no API-origin GitHub mirror or required export job in the new target. |
| D-015 | Initial semantic indexing provider will be OpenAI `text-embedding-3-small`, behind a replaceable adapter and a **separate optional embedding worker**. | Low operational overhead and cheap bounded usage for the initial workload; failure cannot block capture, and external processing/privacy must be disclosed. |
| D-016 | Plan tenant-scoped hybrid PostgreSQL search (lexical + pgvector) and authenticated, token-scoped MCP tools, while preserving repo-based ChatGPT search as the **current** interface. | Retrieval quality and owner isolation must be verified before enabling new search by default; OAuth capability/compatibility must be proven, not assumed. |
| D-017 | Use ChatGPT interactively for initial intelligence/ledger narrative over sourced evidence; DeepSeek and unattended LLM hosting remain undecided. | Avoid premature LLM backend deployment and claims that a ChatGPT subscription covers API processing. |
| D-018 | Web UX will expose existing, clickable per-user tag facets; standard/canonical tag taxonomy remains a later product decision. | Support discovery now without inventing fixed categories or rewriting historical notes. |
| D-019 | **Accepted 2026-10-17:** PostgreSQL is the authoritative operational store for originals, owner/source provenance, DB jobs, search, embeddings, reminders, ledgers and other derived state. Optional private GitHub Markdown remains an independent input (and current legacy search interface); API/MCP capture persists to DB directly. Workers operate on DB jobs and save DB results. **No mandatory DB -> GitHub replication.** | Avoid an always-on MCP dependency for GitHub capture without making GitHub a second processing backend. Require durable import cursors/reconciliation and truthful persistence statuses; backup automation #61 is deferred under D-020; preserve the existing GitHub finalization implementation until its separately tested migration. |
| D-020 | **Accepted owner decision 2026-10-18:** defer backup/PITR/export automation (#61) to later or manual operation; prioritize working functionality. Keep the completed synthetic recovery drill as an optional tool. | Backup automation is not a prerequisite for current functional delivery or starting the project. No production backup or recovery guarantees are claimed. Revisit only when requested. |

## Proposed implementation defaults (subject to prototyping)

| ID | Proposal | Validation needed |
| --- | --- | --- |
| P-001 | **Historical/current:** `inbox/` -> worker -> `notes/YYYY/MM/`; `rejected/` for invalid input. Target #43 migration may remove GitHub finalization writes while retaining safe validation, rejection and DB checkpointing. | Existing adapter operation and migration safety; no GitHub write-back requirement under D-019. |
| P-002 | Stable ULID or UUID note IDs; unique capture IDs, original transcript retention. | Validator implementation and collision/retry tests. |
| P-003 | One primary `kind`, controlled `action_hint`, multiple domains/projects/tags. | Evaluate real voice samples and taxonomy drift. |
| P-004 | GitHub ingestion polls/reconciles from durable revision checkpoints; webhooks may accelerate discovery but never substitute for catch-up. | Lost webhooks, downtime, changed revisions and bounded rescan require tested recovery. |
| P-005 | Client apps only access authenticated backend API, not GitHub. | Authentication and deployment choices. |
| P-006 | Start with deterministic ledger facts; LLM summaries are sourced, separately stored, and recomputable. | Summary quality and cost. |
| P-007 | Expo push with an API-owned reminder scheduler and durable delivery records. | Device testing, permissions and reliability. |
| P-008 | Monorepo modules: `apps/{api,worker,web,mobile}`, `packages/{core,contracts,api-client}`. | Avoid premature packaging. |

## Implemented contract constraints (2026-10-15, issue #6)

- D-003 now has an executable **v1 Markdown validator/serializer** in `@pce/core`, with synthetic adversarial tests; no worker, GitHub adapter or persistence is implemented by this change.
- P-002/P-003 are partially validated by code: only ULID/UUID identifiers, strict offset-bearing timestamps, defined enum values, non-mutating lowercase slug validation and constrained YAML syntax are accepted. This is an intentional compatibility restriction; widening syntax or changing identity/collision policy requires a version-aware migration.
- **Original input is terminal** in v1 Markdown: all Markdown after `## Original input` belongs to the original transcription. Optional descriptive sections go before it. No tags, action hints or deadlines are inferred at parse time.

## Partial identity verification increment (#44; not a production decision)

The existing D-012 interim HS256 verification remains supported for disposable
local sessions. A second pinned RSA public-key/RS256 verifier can be configured
as an alternative (never concurrently), with the same issuer/audience/scoped
subject checks. This is a **partial implementation**, not acceptance of an
identity provider or completed #44: there is no token minting, OAuth/PKCE,
refresh/revocation, JWKS discovery, multi-key rollover or production account
mapping. Production deployment and a change of default login flow require a
separate review and verified operator setup. See the authentication threat
boundary in [security](09-security-and-privacy.md#pinned-issuer-rs256-verification-foundation-44-partial).

## Deferred decisions

- Choose the hosted/scheduled LLM provider, budget and execution model for unattended aggregators.
- Rich editing/deletion/conflict semantics **within** the DB-primary model; the operational source-of-truth decision itself is settled in D-019.
- Optional user-initiated GitHub/portable export and any bidirectional synchronization; neither is a capture requirement.
- Final authentication provider, hosting, scheduler and push transport.
- Production embeddings, vector search rollout, knowledge graphs and autonomous external integrations (embedding provider/direction now accepted in D-015/D-016, implementation still pending).
- Hardware recorder/always-on capture and retained audio storage.
- Cross-user sharing, multi-tenant accounts and sophisticated offline-first conflict handling.

## Blocking implementation questions / experiments

1. **Content privacy:** make `personal_context_engine_content` private before adding any personal notes.
2. **Connector viability:** verify the ChatGPT Project can create files in the selected private repository with acceptable confirmation friction. Do not assume connector read access implies write access.
3. **GitHub ingestion:** test moving files, retries, rate limits, repo history and permissions with fake fixtures.
4. **Capture fidelity:** evaluate multi-idea utterances, uncertain reminder dates, transcription errors and missing fields.
5. **Model economics:** interactive ChatGPT use does not entitle server workers to free API inference.
6. **Notification model:** specify timezones, permissions, duplicates, quiet hours and failure semantics before promising alerts.

When a deferred item is decided, add a numbered decision with date and migration consequences.


## Implemented projection constraint (2026-10-16, issue #8)

D-004/D-006 now have an initial Prisma 6/PostgreSQL 16 projection schema,
checked-in SQL migration and serializable typed import repository. This is a
replayable **projection**, not a change to the Markdown source-of-truth policy.
Note ID uniqueness, opaque content revision compare-and-swap, original-offset
preservation, restricted capture deletion and noncascading attempt metadata
are deliberate compatibility rules. No private API reads, ownership mappings
or worker finalization are added here; those require #13 and #10.

## Interim authentication constraint (2026-10-16, issue #13)

D-012 implements a token **verification** adapter and opt-in synthetic private
note routes. Production-like startup requires issuer/audience/key config and
fails closed if absent. An authenticated `notes:read` principal is scoped
by the trusted reader; missing/forged tokens get 401, insufficient scopes
403, and other-owner note IDs 404. The API does not mint tokens or connect
the unowned DB projection to note routes. Adding persisted ownership
migration, token issuance/refresh, revocation, and a production ingress
remains separate future work. The final authentication **provider** is still
deferred; replacing the verification adapter does not revise D-012's
authorization invariants.

## Implemented ingestion boundary (2026-10-16, issue #10)

P-001/P-004 now have a deterministic opt-in one-shot worker, with ContentStore compare-and-swap transitions, PostgreSQL processing-attempt leases and replayable `PERSISTED` recovery. The default developer process remains inert. Workers never infer reminders from prose or enqueue notifications; captured `due_at` is projected with its original offset, and absent `due_at` stays absent. A content conflict is left for manual repair. This does **not** authorize private GitHub ingestion, a scheduler, active notifications or authenticated DB reads. Five-minute leases and bounded backoff are implementation defaults, not a cross-system ACID guarantee.

## Project capture experiment state (2026-10-16, issue #12)

Versioned ChatGPT Project capture instructions and an offline synthetic-export
verification script are prepared in [the Project runbook](12-chatgpt-project.md).
This is **experiment infrastructure, not a go-live decision**. In particular,
the actual ChatGPT Project write/read-back capability, confirmation friction,
multi-idea and ambiguous-reminder scenarios, denied-write behavior and
notification delivery remain unverified. Project mode must be exercised
manually with synthetic prompts, with sanitized observations recorded in #12,
before deciding go/no-go or changing the accepted replaceable-capture design.

## Client integration boundary (2026-10-16, issue #14)

Web and Expo now consume the same `@pce/api-client` typed GET routes.
Manual one-session JWT entry is only a synthetic development affordance,
not an acceptance of a production login provider or client-side token
persistence. Mobile `pce://notes/<id>` selects a route and always
re-authorizes note detail via the API. Production identity, device credential
storage, push delivery, owner-aware DB note readers and authenticated
write APIs remain deferred. Remote bearer transport remains HTTPS only.

## Local single-user development workspace (#38)

The explicit `dev:local` entry point connects a trusted local Markdown
checkout, PostgreSQL and read-only web UI. It assigns persisted ownership
on new imports, filters SQL reads by the verified local subject plus
validated checkout IDs, and issues short-lived sessions from a loopback,
same-origin development endpoint. Its signing key is ephemeral and its
content import never changes the checkout. Legacy ownership is not guessed.
This is a local development implementation, not a production login/provider
decision, a mobile session mechanism, a scheduled ingestion deployment or
reminder delivery. Generic API/worker startup retains existing defaults.

## Developer ingestion and harmless capture syntax (#40)

The v1 parser accepts explicit bare or quoted lowercase slug flow arrays
for domains/projects/tags while retaining the restricted YAML security
boundary and unchanged original input. An opt-in `dev:local` worker polls
the configured verified private repository every 30 seconds while running,
persists then finalizes notes, refreshes the checkout and reports status.
This is an implementation of local ingestion, not hosted scheduling,
reminder delivery or a production authentication decision. Legacy preview
revisions are bridged only through same-owner/path and exact-byte proof,
with a narrowly verified Git CRLF checkout conversion where needed.

## Progressive evolution decision boundary (2026-10-16; revised 2026-10-17, #42)

**Accepted product direction is not shipped functionality.** D-013 and D-015–D-018 retain the capture-preservation, provider and UX decisions; D-019 defines the superseding DB-primary target. Implementation is tracked in #43–#56 and recovery issue #61. D-004 describes the existing GitHub-first implementation; D-019 (2026-10-17) supersedes D-004/D-014 **for the target**, while migration of the existing importer/finalization code must be separately reviewed and validated. Under owner decision D-020 (2026-10-18), backup/PITR/export automation (#61) is deferred to later or manual operation and is not a delivery prerequisite. No production backup guarantees are claimed.

Two independent capture input paths now converge into **one durable PostgreSQL authority**. A GitHub input write is not proof of database ingestion, and an API-origin DB commit does not entail a GitHub copy. Existing repo capture/read continues unchanged pending an explicit validated migration; retrieval provider changes remain independent from capture persistence. No production OAuth identity system, embedding runtime, MCP service, automatic ledger generator, mobile push system or curated tag taxonomy is implied by this decision.


## Durable local GitHub scan boundary (2026-10-18, issue #43)

The opt-in local poller now persists repository/branch/owner-scoped discovery
progress and observed/reconciled Git snapshot metadata in PostgreSQL. Bounded
scans resume across restarts and wrap for webhook-independent reconciliation;
conflicts and disappeared sources retain DB originals. The local UI reports
sanitized reconciliation counts and timestamps. The standalone GitHub once-mode
worker independently verifies private visibility and persists its scan cursor.
This does not deploy a hosted scheduler, change default ChatGPT repository
search, authorize source revisions/deletion, or retire GitHub finalization.
The existing single-content-repository-per-DB constraint remains; production
identity and DB-primary job processing still require their separate issues.
See [the operation/recovery contract](05-ingestion.md#durable-local-reconciliation-43).


## Gated local browsing implementation (2026-10-18, issue #52)

An explicit disabled-by-default local flag enables bounded database pages,
literal full-note substring search, observed project/kind facets and structured
original detail in the existing owner-scoped local workspace. This implements
the local web browsing slice under D-018 without changing ChatGPT's repository
search default or claiming #48 hybrid retrieval, production identity or hosted
availability. Original text and advisory fields remain read-only. No schema or
content migration is required; clearing the flag restores the legacy preview.
See [the local browse contract and synthetic evidence](08-clients-and-notifications.md#opt-in-local-database-browsing-52).

## Proposed taxonomy research boundary (2026-10-18, issue #54)

**No new taxonomy decision has been accepted.** D-018 continues to authorize
observed, owner-scoped tags and clickable facets, but not a standard/default
vocabulary, automatic synonyms or modification of historical tag slugs.
The alternatives, evidence requirements, synthetic examples and reversible
read-projection sketch are in
[the domain/taxonomy specification](06-domain-and-taxonomy.md#optional-taxonomy-research-and-reversible-alias-approach-54-not-approved).

The least disruptive *candidate* is optional, dismissible suggestions. Any
owner-scoped alias mapping is a **separate future opt-in**, with raw/source tags
unchanged, distinct-note facet counting, explicit versioning and reversible
display/filter behavior. Global required tags and destructive renaming are not
recommended. This is a research conclusion, **not** permission to implement
a schema migration, alter capture prompts, change the API contract or process
private corpus metrics in public CI.

**Decision pending:** obtain representative owner-authorized tag usage
observations and direct owner feedback on synonym meaning and workflow
friction; review privacy and backward compatibility; then record a dated,
numbered accepted decision or retain D-018 with no change. Issue #54 stays
open for those product inputs; a docs-only PR does not close it.

## Embedding worker completion boundary (2026-10-19, issue #47)

The opt-in, finite DB embedding worker has a replaceable OpenAI adapter,
idempotent chunk/model jobs, lease recovery and bounded retries. Follow-up
completion adds durable owner/day request reservations and rate windows,
resumable preparation checkpoints, explicit startup privacy validation, and
synthetic provider-to-PostgreSQL tests. The server-only owner-scoped lexical
fallback reads DB originals independently of provider/index availability,
including DB-only source records. HTTP/hybrid retrieval and default search
activation remain #48/#50; no identity provider, automatic ingress hook,
continuous deployment or actual private-text egress is implied. See the
[worker runbook](03-repositories-and-operations.md#explicit-embeddings-pass-issue-47).

## D-021 — Single-user sign-in (accepted owner direction 2026-10-20)

For the current personal deployment, follow SportOS's fixed-owner model rather
than requiring a new external identity provider: a configured username/scrypt
password for hosted access, opaque DB-backed sessions, HttpOnly cookies and
CSRF for browser writes. Explicit local development may bootstrap that same
owner only on loopback; it cannot authenticate a hosted issuer. Existing note
ownership remains unchanged and legacy null owners are not adopted. Scoped,
short-lived delegated API tokens share the same login and session revocation.
OAuth/PKCE delegation for MCP is #49; multi-user/OIDC onboarding is deferred.

## Independent API capture implementation (#45)

The scoped API can now commit original Markdown/notes, owner provenance,
idempotency receipt and DB preparation jobs in one transaction, without GitHub
or embedding availability. The existing GitHub importer is unchanged except
that split captures cannot link different persisted owners. A bounded DB-only
preparation worker hands work to the existing embedding queue; no automatic
external actions or production deployment is selected.

## Gated DB retrieval implementation (#48)

The explicit DB search mode adds owner-scoped full-text/exact vector candidates,
rank fusion, signed bounded pagination, source provenance and original detail.
The web search consumes this API through the same single-user session. Provider,
index or budget unavailability degrades to lexical DB originals, including
API-only records. Query processing is independently egress-gated and bounded;
UTF-8 byte-based reservations avoid charging every short input as a maximum-sized
chunk while retaining the hard daily ceiling. ChatGPT repository search remains
unchanged; remote connector/cutover and production benchmarks remain independent.

### D-022 — Optional same-login OAuth MCP local delivery (2026-10-20)

**Implemented locally; hosted compatibility unverified.** Issue #49 reuses D-021
single-user browser sessions for explicit OAuth consent, with exact operator
preregistration, S256 PKCE, one-use hashed codes and short-lived scoped grants.
The official SDK implements stateless Streamable HTTP; owner comes only from
verified identity. No remote client metadata fetch, public tunnel, GitHub export
requirement or automatic ChatGPT retrieval cutover is introduced. See
[protocol and verification boundaries](18-mcp.md). Hosted HTTPS and live ChatGPT
acceptance remain open and must be observed before claiming completion.

## D-023 — Initial hosted deployment (accepted owner direction 2026-10-20)

Deploy the React web app to Vercel and the Fastify API to Render, with automatic
redeployments from `main` only and all branch/PR previews disabled. Reuse the
existing PostgreSQL, persisted owner and D-021 fixed single-user password
sessions. Proxy browser API/auth through the Vercel hostname to preserve exact
origin checks and host-only cookies. DB/OpenAI credentials belong only in
Render's server environment. MCP/ChatGPT connection and retrieval cutover remain
separate follow-up work; existing GitHub capture/search stays available. See
[deployment setup and verification](19-hosted-deployment.md) and issue #79;
configuration alone does not establish a successful live deployment.

## Hosted reader wiring (#81)

The explicitly gated standalone API now uses owner-scoped DB originals for the
timeline, observed tags/facets and source detail, including API-only records.
Local browsing retains its checkout snapshot restriction. No new authentication
provider, schema change, MCP enablement or repository-search cutover is implied.

### Hosted MCP proxy preparation (#83)

The optional hosted MCP adapter retains the canonical Vercel issuer/resource and
same-login consent. A trusted operator may pin the separate Render transport
origin; forwarded headers cannot change identity or allowed hosts. RFC 9207
issuer identification enables compatible client registration. The first
ChatGPT client is read-only (`notes:read`); owner consent and live acceptance are
separate from code verification. Existing GitHub capture/search and #50's
explicit cutover gate remain unchanged.

### Hosted OAuth callback browser policy (#93)

Consent permits form navigation to self and the validated registered callback
origin, because Chrome applies `form-action` to the successful POST's redirect.
Exact callback registration, CSRF, PKCE and scoped grant checks remain required;
no wildcard destination or script execution is enabled.

### Optional search explanation (#97)

The separately gated `diagnose_search` MCP tool explains owner-scoped index health,
cosine scores and existing lexical/semantic/RRF rankings. It reuses the approved
query provider and shared budgets, makes no content/indexing changes and is absent
by default. Production threshold/ranking and retrieval cutover policy remain
unchanged. Synthetic protocol/database checks establish the mechanism; live
private investigation evidence stays outside this public repository.

### Explicit recurring embedding operation (#101)

Owner-authorized recurring indexing uses a separate opt-in worker with bounded
existing preparation/indexing passes, a post-cycle cooldown and durable scan
wrap/recovery. Capture and default development startup remain independent of
provider availability. SQL still enforces request/token ceilings; short chunks
may use their actual conservative reservation when less than a maximum-sized
chunk's allowance remains. Local supervision is supported but does not establish
hosted continuous indexing. Thresholds, ranking and retrieval cutover do not
change.

### D-024 — Temporary GitHub connector capture UX bridge

The owner currently uses the ChatGPT `NOTES` Project as a low-friction capture
surface: open the Project, type or dictate, send, and let its instructions route
Markdown v1 capture through the GitHub connector to the private content inbox.
That GitHub connector dependency is an **explicit temporary integration
workaround**, not a required component of Personal Context Engine architecture.
Preserve this observed workflow while a genuinely no-extra-step replacement is
unproven. This owner observation does not replace the full synthetic acceptance
matrix in #12.

PostgreSQL remains the authoritative operational store. The GitHub connector
is a removable ChatGPT-side ingress adapter; GitHub importer/finalization
implementation details are independently replaceable. API/MCP-origin notes must
not be exported to GitHub by default. Disabling the workaround must not require
schema migration, a second write of existing notes, or removal of historical
GitHub-origin provenance. Avoid turning the temporary adapter into a permanent
dependency in processing workers or search.

ChatGPT Project instructions can express *which* tool to prefer but cannot
install, authorize, permanently pin, or guarantee automatic invocation of a
custom MCP action for each new message. A manually repeated `@Personal Context
Engine` mention or per-message tool selection is not an acceptable **required**
regression for everyday text/voice capture. MCP availability, supported write
actions/scopes and project-level invocation are separate gates. Test a fresh
Project chat, successive text and voice captures without manual preselection,
confirmation friction, idempotency, DB persistence and failure recovery before
retiring the GitHub capture path. If the ChatGPT product surface cannot meet
this gate, keep the removable GitHub fallback.

A future one-way, bounded and versioned publication of owner-approved taxonomy
to the **private** GitHub repository, solely for ChatGPT GitHub-based context,
may be evaluated as a separate compatibility projection. It is **not
implemented or authorized by this decision**; keep it feature-gated, removable,
and distinct from capture ingestion and general DB-to-GitHub replication. See
[the evolution plan](13-evolution-plan.md#chatgpt-project-capture-ux-bridge-d-024)
and #95.

### D-025 — User-curated tag vocabulary and removable snapshot

**Accepted product behavior (2026-10-21). Storage/import/index/retrieval/UI mechanisms implemented in #104; live Project acceptance remains #105.** Each note's
original Markdown v1 `tags` list is source classification, **not** an approved
vocabulary. A tag is **approved** only when its slug is present in the
owner-scoped PostgreSQL registry; other observed/LLM-suggested slugs are
**candidates**. A model may assign zero tags and should prefer useful approved
slugs over inventing many single-use labels. Approved status is an owner
decision, never an LLM self-promotion and never authorization to execute tasks.

The UI must support (a) clicking tag text to filter notes, (b) a distinct
one-click action to promote a candidate into the registry, and (c) attaching
and detaching tags on a specific note, including free-form newly added tags,
without implicitly approving them globally. Removing a tag from one note does
not delete it from the registry or other notes.

Preserve GitHub-sourced original text, file hash, historical slugs and
provenance: manual attach/detach is a database-side **effective-tag override**
with audit/concurrency rules, applied consistently to facets, filtering and
hybrid search. Imports and replay must not overwrite user edits. The registry
and note editing work with **no GitHub exporter**.

**Temporary ChatGPT bridge (#100):** a feature-flagged, one-way owner-approved
snapshot may be published at a dedicated path inside the verified private
content repo by a **new durable job handler in the existing worker** (not a
separate service). Coalesce changes, avoid duplicate commits by content hash,
retry safely, and expose lag; the interactive capture agent only **reads**
this snapshot and never modifies it. Turning off the exporter cannot break
capturing, tag editing, indexing or searching. Final ChatGPT Project prompt
integration belongs solely to #105 after the features are delivered. Earlier
#54 discussions of canonical/global taxonomies are superseded for the
candidate/approved workflow but remain relevant to optional aliases.

### D-026 — Ordinary MCP-grounded contextual research

**Accepted product behavior (2026-10-21). Storage/import/index/retrieval/UI mechanisms implemented in #104; live Project acceptance remains #105.** A user
may explicitly request research and its capture during an **ordinary ChatGPT
Project conversation**. This is **not the product-specific ChatGPT Deep
Research feature**, not an always-on research agent, and not an LLM job run by
the PCE worker. Regular memos never automatically trigger research.

Before forming a context-complete report, the assistant **must** use the
Personal Context Engine MCP to search related existing notes (prefer
`search_context`; use `search`/`fetch` within the same MCP as a compatibility
fallback) and read the relevant originals via `get_note`/`fetch`. External
web sources are investigated as the prompt warrants. Distinguish note
evidence (IDs/revisions) from external evidence (URLs/dates); if PCE search
returns no matches, record a successful empty search. If the MCP is unavailable,
**never** silently substitute GitHub search or claim the report was fully
grounded: give an explicit incomplete/unavailable status, preserve any safely
captured ordinary note, and allow a retry.

Capture an ordinary immutable Markdown v1 Note and a separately versioned
`ResearchReport` related to that note and any existing context note IDs. Store
findings, real citations/source snapshots, verification date, provenance,
limitations and revision history. The private GitHub research-ingress adapter
is separate from the note inbox and **must** have a tested narrow allowlist;
two GitHub writes are not atomic, so import and UI must handle partial success
and idempotent retry. The existing worker imports/validates/indexes via DB
jobs; it does not author research. PostgreSQL remains authoritative. The
new report schema and UI/search/API contract are implementation work #104,
described by [the research design](20-research-capture.md).

**Rollout order:** implement #99 and #103; optional #100 GitHub taxonomy
projection; #104 report contract, public/private repo implementation and
synthetic tests; **only then #105** reviews/combines the installed ChatGPT
`NOTES` prompt and runs real Project acceptance. Prompt text does not
automatically attach/authorize MCP tools.

## Final NOTES integration checkpoint (#105, 2026-10-23)

A private notes-v2.0 installation candidate consolidates ordinary capture,
approved-tag hints and explicit MCP-grounded research, with a separate concise
capture-only rollback. The public implementation adds owner-scoped searchable
catalog pagination and a combined synthetic acceptance path. Existing installed
Project settings remain unchanged. Live voice, candidate prompt installation and
owner go/no-go remain manual gates; tests/self-review do not approve activation.
