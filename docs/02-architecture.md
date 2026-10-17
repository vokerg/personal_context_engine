# 02 — System architecture

## Context

Personal Context Engine consists of an **input channel**, a **durable interchange layer**, an **ingestion worker**, a **query model**, and **read/interaction clients**. None of these layers should depend on a particular voice application, hosted LLM, or Git storage provider.

```mermaid
flowchart TD
  U[Person: voice or text] --> CP[ChatGPT Project: first capture client]
  U --> MC[Expo capture: later]
  CP -->|validated Markdown| CR[(Private content repository)]
  MC -->|authenticated create request: later| API
  CR -->|new inbox files| W[Worker: validate, reconcile, import]
  W -->|query projection| DB[(PostgreSQL)]
  W -->|move or mark processed| CR
  DB --> API[Fastify API]
  API --> WEB[React web]
  API --> MOB[React Native / Expo]
  W --> LED[Ledger generation service]
  LED -->|sourced derived artifacts| CR
  LED -->|metadata and history| DB
  API --> NOTIF[Notification scheduler / push provider]
  NOTIF --> MOB
```

The diagram is **target architecture**, not deployed infrastructure. `CP -> CR` is a hypothesis that must be tested inside the chosen ChatGPT Project configuration. Unattended ledger generation requires an explicit, supported LLM provider or a deterministic-only implementation.

## Components

| Component | Responsibility | Does NOT own |
| --- | --- | --- |
| Capture client | Obtain user input; output one or more schema-compliant records with provenance | DB transaction logic, system-wide side effects |
| Private content storage | Durable source Markdown for captures/notes and optionally derived ledger Markdown | Public CI or application source code |
| Ingestion worker | Detect incoming files, validate schema, upsert DB projection, transition files, retry safely | Inventing personal data or silently executing LLM actions |
| Core domain | Types, invariants, taxonomy, reminder/ledger rules | GitHub, HTTP, Prisma, ChatGPT implementations |
| Database | Queryable notes, tasks, reminders, metadata, processing and delivery status | An independent conflicting copy of editable Markdown |
| API | Authentication, authorization, query commands, presentation-ready read endpoints | Knowledge of mobile secrets or GitHub credentials in the client |
| Web/mobile | Browse, search, review, receive notifications; future capture/editing | Direct access to content repo or DB |
| Ledger service | Deterministic aggregation + optional attributed LLM narrative | Permanent authority over source facts |
| Notification service | Evaluate scheduled reminders and deliver opt-in push messages | Treat push delivery as guaranteed execution |

## Storage and data ownership

- **Source note Markdown (initial):** durable record of original text and structured classifications in private content repository.
- **DB projection:** derived, indexed state for searching, filtering, app reads, task/reminder views and reliable processing status.
- **Derived artifacts:** ledgers, links, embeddings and LLM commentary are reproducible. Keep source IDs and generation metadata.
- **Operational state:** processing leases, retry attempts, notification delivery records and external action approvals live in the DB; do not encode queue semantics solely in human tags.
- **Future editing:** API writes must either produce an authorized source update with conflict handling or wait until the source-of-truth decision changes. No silent dual writes.

## Replaceable interfaces

These are conceptual ports, not promised compiled APIs:

```ts
interface ContentStore {
  listPending(cursor?: string): Promise<ContentFile[]>;
  read(path: string): Promise<ContentFile>;
  finalize(input: FinalizeRequest): Promise<void>;
}

interface NoteRepository {
  upsertFromSource(note: ValidatedNote, sourceRevision: string): Promise<void>;
  getById(id: string): Promise<Note | null>;
}

interface IntelligenceProvider {
  classify(capture: CaptureInput): Promise<NoteDraft[]>;
  summarize(input: LedgerEvidence): Promise<SummaryDraft>;
}

interface PushProvider {
  send(device: RegisteredDevice, message: PushMessage): Promise<DeliveryResult>;
}
```

Implement adapters independently. `ContentStore` may begin with GitHub and later use local files or object storage. `IntelligenceProvider` may be interactive/manual at first; an API implementation requires separate credentials and billing.

## Trust and execution boundaries

1. **User input and LLM output are untrusted:** strict YAML/schema validation, size limits, safe parsing, allowlisted labels, and controlled file paths.
2. **Public CI is lower trust than runtime:** do not provide content repository tokens or private DB connections to PR jobs.
3. **Mobile/web are untrusted clients:** access only through authenticated API; do not ship PATs, private keys or DB URLs.
4. **External action boundary:** a model-emitted `action_hint` is advisory; actual sends, edits, scheduled reminders and project changes require deterministic policies and permissions.
5. **Source preservation boundary:** moving a file in Git is not a distributed transaction with PostgreSQL; design for retries and reconciliation.
6. **Privacy boundary:** personal content must never be mirrored to this public repository, build artifacts, issue bodies or error telemetry.

## Reliability and observability

Every ingestion should be traceable by `note_id`, `capture_id`, source path/revision and a processing attempt ID. Store failure reasons without leaking note text. Log statuses, durations and counts; logs and tracing must not contain raw content by default. Reconciliation should detect DB-imported-but-not-finalized files, missing projections and changed source revisions.

## Domain-driven layering

Routes validate transport and auth; application services orchestrate; domain code implements invariants; infrastructure adapters implement GitHub, Prisma, LLMs and push. Keep API and worker thin, sharing domain packages but not sharing transport-specific state.

## Progressive architecture: parallel channels (accepted direction; not deployed)

The existing diagram above describes the original GitHub-first target. The **next evolution**, documented in [13 — Evolution plan](13-evolution-plan.md), adds capabilities **without replacing** the active path:

```mermaid
flowchart TD
  CHAT[ChatGPT / GitHub connector] -->|current Markdown capture| GIT[(Private GitHub content)]
  CHAT -->|current search/read| GIT
  GIT -->|current import| ING[Deterministic ingestion worker]
  ING --> DB[(PostgreSQL)]
  MCP[Future ChatGPT MCP tools] -->|scoped user access token| API[Authenticated PCE API]
  WEB[Web/mobile clients] -->|scoped bearer session| API
  API -->|future capture + durable outbox| DB
  OUT[Future GitHub export worker] -->|idempotent create-only replication| GIT
  DB -->|pending export jobs| OUT
  DB -->|pending index jobs| EMB[Future embeddings worker]
  EMB -->|server-side private input, opt-in| OPENAI[OpenAI embeddings API]
  EMB -->|vectors + provenance| DB
  API -. gated future retrieval .-> DB
  CHAT -. interactive ledger tools later .-> MCP
```

For GitHub-origin captures, the current Markdown document remains the source of truth and the DB a projection until an explicitly approved policy change. For future API-origin captures, commit canonical source bytes, verified ownership and an export job **in one PostgreSQL transaction**, then synchronize them to GitHub asynchronously; two independent network writes are not an atomic transaction. The processing and export jobs require deduplication, explicit statuses and crash recovery.

`apps/api` stays the authenticated transport boundary; `apps/worker` adds independent ingestion, embedding and export job handlers behind ports; `packages/db` owns migrations/queries; `packages/core` keeps portable capture/chunking rules; `packages/contracts` owns typed tool/API shapes. These describe future modules, **not directories already implemented**. Search through the GitHub connector remains the active ChatGPT interface until the DB-search evaluation gate passes. All reads and writes must scope by verified owner. See #42 and [security](09-security-and-privacy.md).
