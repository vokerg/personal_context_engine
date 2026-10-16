# 11 — Architectural decision register

**Baseline date: 2026-10-15.** An accepted decision is a **product direction**, not a claim of implemented software. Revisions should document what changed, why, and the migration impact.

## Accepted decisions

| ID | Decision | Rationale |
| --- | --- | --- |
| D-001 | Separate **public mechanism** (`vokerg/personal_context_engine`) and **private personal content** (`vokerg/personal_context_engine_content`). | Independent permissions, public CI, open-source potential. |
| D-002 | ChatGPT Project is the first capture and interactive aggregation interface, but replaceable. | Low-friction voice entry, portability. |
| D-003 | Versioned Markdown with structured frontmatter is the ingestion interchange format. | Human readability, LLM friendliness and portability. |
| D-004 | Retain both files and PostgreSQL; use Markdown as the first-stage source of truth, DB as projection. | No premature storage lock-in; preserve query capability. |
| D-005 | Public web = **React + Vite**; mobile = **React Native + Expo**. | Shared React ecosystem and typed APIs. |
| D-006 | Backend/worker = Node.js + TypeScript; API = Fastify; PostgreSQL/Prisma; npm workspaces. | Aligns with existing development practices. |
| D-007 | Mobile app is required, especially for notifications and browsing; mobile capture is a later extension. | Product reach beyond the chat interface. |
| D-008 | Ledgers: daily, weekly, monthly; per-project ledgers are a natural extension. | Re-surface useful context rather than archive it forever. |
| D-009 | The public repository owns code, schemas and CI; the content repository contains no app CI. | Strong separation of operational responsibilities. |
| D-010 | No external action is executed solely due to a model-assigned tag. | Prevent accidental or unauthorized side effects. |
| D-011 | Non-trivial engineering work is GitHub issue-first, one reviewable PR per issue, with CI evidence and explicit human approval before merging. | Auditability, reproducible agent execution and separation of author from reviewer. |
| D-012 | Interim authenticated API uses strict short-lived HS256 JWTs behind a replaceable verifier, with server-only signing keys and verified-subject scoping. | An auditable zero-external-service boundary for synthetic tests; future hosted OIDC/JWKS and key rotation are explicitly permitted without changing route authorization. |

## Proposed implementation defaults (subject to prototyping)

| ID | Proposal | Validation needed |
| --- | --- | --- |
| P-001 | `inbox/` -> worker -> `notes/YYYY/MM/`; `rejected/` for invalid input. | GitHub write/move behavior and operational ergonomics. |
| P-002 | Stable ULID or UUID note IDs; unique capture IDs, original transcript retention. | Validator implementation and collision/retry tests. |
| P-003 | One primary `kind`, controlled `action_hint`, multiple domains/projects/tags. | Evaluate real voice samples and taxonomy drift. |
| P-004 | Worker polls changed repository state first; webhooks may replace polling. | Hosting, API limits and consistency. |
| P-005 | Client apps only access authenticated backend API, not GitHub. | Authentication and deployment choices. |
| P-006 | Start with deterministic ledger facts; LLM summaries are sourced, separately stored, and recomputable. | Summary quality and cost. |
| P-007 | Expo push with an API-owned reminder scheduler and durable delivery records. | Device testing, permissions and reliability. |
| P-008 | Monorepo modules: `apps/{api,worker,web,mobile}`, `packages/{core,contracts,api-client}`. | Avoid premature packaging. |

## Implemented contract constraints (2026-10-15, issue #6)

- D-003 now has an executable **v1 Markdown validator/serializer** in `@pce/core`, with synthetic adversarial tests; no worker, GitHub adapter or persistence is implemented by this change.
- P-002/P-003 are partially validated by code: only ULID/UUID identifiers, strict offset-bearing timestamps, defined enum values, non-mutating lowercase slug validation and constrained YAML syntax are accepted. This is an intentional compatibility restriction; widening syntax or changing identity/collision policy requires a version-aware migration.
- **Original input is terminal** in v1 Markdown: all Markdown after `## Original input` belongs to the original transcription. Optional descriptive sections go before it. No tags, action hints or deadlines are inferred at parse time.

## Deferred decisions

- Choose the hosted/scheduled LLM provider, budget and execution model for unattended aggregators.
- Whether and when PostgreSQL becomes the editable source of truth.
- Bidirectional write-back semantics and merge/conflict policy.
- Final authentication provider, hosting, scheduler and push transport.
- Embeddings, vector search, knowledge graphs and autonomous external integrations.
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
fails closed if absent. An authenticated \`notes:read\` principal is scoped
by the trusted reader; missing/forged tokens get 401, insufficient scopes
403, and other-owner note IDs 404. The API does not mint tokens or connect
the unowned DB projection to note routes. Adding persisted ownership
migration, token issuance/refresh, revocation, and a production ingress
remains separate future work. The final authentication **provider** is still
deferred; replacing the verification adapter does not revise D-012's
authorization invariants.
