# 05 — Worker ingestion and data lifecycle

**Status:** deterministic one-shot implementation (#10) with a synthetic filesystem/PostgreSQL execution path; production private-repository deployment and scheduling are not verified. File placement indicates **processing state**, not whether the human task described by the note is complete.

## File lifecycle

```mermaid
stateDiagram-v2
  [*] --> Inbox: capture writes Markdown
  Inbox --> Validate: discover new revision
  Validate --> Rejected: malformed / unsupported
  Validate --> Persist: valid
  Persist --> Finalize: durable DB upsert
  Finalize --> Accepted: move to notes/YYYY/MM
  Persist --> Retry: transient failure
  Finalize --> Retry: Git conflict / outage
  Retry --> Validate: retry with lease
  Rejected --> Inbox: user repairs
```

- `inbox/`: not finalized into canonical note storage.
- `notes/YYYY/MM/`: valid canonical files successfully imported and finalized.
- `rejected/`: preserved invalid files and repair metadata, with no data loss.
- Task or reminder completion is tracked **separately** in domain state; never use `notes/` versus `inbox/` as task status.

## Worker responsibilities

1. **Discover:** poll the repository's inbox (first adapter) using an incremental cursor/revision; later support trusted webhooks.
2. **Acquire processing lease:** prevent racing workers and record source path, SHA, attempt ID and timestamps.
3. **Read and validate:** parse schema v1 safely, normalize fields and compute a content hash. Reject invalid input with a useful reason and no destructive deletion.
4. **Project to PostgreSQL:** idempotent transaction/upsert keyed by note ID, with provenance `capture_id`, source revision, content hash and processing state.
5. **Derive candidates:** create task/reminder suggestions or events as data only; do not execute side effects solely on a tag.
6. **Finalize storage:** move or copy+delete in the content repository, ideally via a single Git tree commit or equivalent compare-and-swap operation; verify resulting source state.
7. **Mark completed:** store canonical path and revision. Publish follow-up work only after durable state is confirmed.
8. **Reconcile:** detect pending-finalization records, retries, changed source files and missing projections.

## Idempotency and Git/DB boundaries

Git and PostgreSQL cannot participate in a shared ACID transaction. Assume crashes can happen after **every** step.

- Enforce unique `note_id` and stable `capture_id` relationships in DB.
- Record source content hash/revision; same revision processed twice must yield no duplicate note, task candidate, reminder or notification.
- DB import **must occur before** final archive/move, so source data survives a partial failure.
- Replaying a DB commit that succeeded before a Git finalization failure must be safe.
- Finalization can be retried with the exact expected source revision; if changed, re-read and resolve rather than overwriting.
- Content differences under the same ID need an explicit update/revision policy, not blind last-write-wins.
- A missing file should trigger reconciliation, not automatic deletion of DB entities.
- Use a durable attempt/state table or equivalent outbox pattern for side-effect scheduling.

## Example recovery matrix

| Failure point | Expected behavior |
| --- | --- |
| Cannot read repo / API rate limit | Retry with backoff, preserve inbox file |
| Invalid frontmatter | Preserve source; mark rejected for repair |
| DB unavailable | Do not finalize Git file; retry |
| DB committed but Git move failed | Idempotent reimport, retry move |
| Worker crashes after move | Reconcile canonical path from Git and mark DB state |
| Two workers see same ID | DB uniqueness + lease/optimistic concurrency |
| New note references unknown project | Preserve note; mark/review association, never invent project |
| Generated ledger fails | Preserve notes and processing; ledger remains stale/error |

## Git mechanics and performance

Start with changed-file polling or bounded scans (design choice pending prototype). Batch API operations where reliable; use compare-and-swap against branch head. Git commits made by the worker can trigger hooks, so filters must prevent self-triggered endless loops. Backoff and pagination handle rate limits.

Do **not** run public mechanism CI or publish note contents on every content commit. Git history itself may retain previously deleted notes.

## Observability and acceptance tests

Record processing status, duration, attempt count, error category, Git SHAs and note IDs. Scrub text/PII from logs. Synthetic tests must prove replay safety, concurrent imports, invalid input preservation, worker crash before/after DB commit, Git move conflict and recovery after restart.

## Later evolutions

- GitHub webhook and worker queue.
- Alternate `ContentStore` adapters.
- Fine-grained versioning and conflict resolution for editing through web/mobile.
- Separate scheduling and aggregation workers when volume requires it.

See [architecture](02-architecture.md), [capture contract](04-capture-contract.md), and [security](09-security-and-privacy.md).

## ContentStore local contract (issue #7)

The first **implemented adapter** lives at `apps/worker/src/content-store/`, with a
provider-neutral `ContentStore` port (`port.ts`) and a synthetic-only filesystem
implementation (`filesystem.ts`). The worker has an explicit `WORKER_MODE=once` execution path with durable database leases and restart recovery. The default development process remains idle until configured.

The adapter API is intentionally smaller than an entire file manager:

| Operation | Contract |
| --- | --- |
| `listPending({ cursor?, limit? })` | Bounded, sorted `inbox/` discovery only, with a seek cursor and per-file SHA-256 content revision. Default 50, maximum 100 files per page. |
| `read(path)` | UTF-8 Markdown plus source revision; 1 MiB local file limit. |
| `stat(path)` | Revision probe or `null` for missing source or destination, for worker reconciliation. |
| `finalize({ sourcePath, expectedRevision, destinationPath })` | Transition from `inbox/` to `notes/YYYY/MM/*.md` only if source matches the observed revision; never overwrite a different destination. |
| `reject({ sourcePath, expectedRevision })` | Preserve malformed input under `rejected/` using its existing basename. The structured validation failure belongs in durable worker/DB state. |

A revision is a **SHA-256 of file bytes** in the filesystem adapter, not a note ID
or Git commit SHA. Later adapters may use other opaque revision schemes; consumers
must only compare revisions from the *same source/provider*. Source identities
are relative paths; canonical note identity comes from the capture validator
(issue #6), and **must not** be inferred from the pathname.

Transitions return `moved`, `recovered` (both source and matching destination
exist following an interrupted copy/delete), or `already_finalized` (source
missing, destination revision matches). Conflicting revisions and unrelated
destinations raise typed `ContentStoreError` codes. On an ambiguous conflict,
the worker must re-read, reconcile and/or ask for repair; it must **not** discard
newer input or silently replace the destination. A completed transition does
not mean its human task was completed.

**Filesystem safety:** a caller explicitly configures an absolute sandbox
root. Only `inbox/*.md`, `rejected/*.md` and
`notes/YYYY/MM/*.md` paths are accepted. The adapter refuses traversal,
absolute source paths, dot segments, hidden filenames, invalid UTF-8,
oversized files, symlinked path components and hard-linked source files;
new destination files use exclusive create and restrictive permissions.
No content body is included in typed error messages or default worker logs.
Never configure the root to a personal home directory or the actual content
repository. Unit/contract tests use temporary directories with **synthetic**
content and do not access external services.

**Atomicity limits:** the portable filesystem adapter writes a destination
copy first, syncs the file, then unlinks the source. These steps are **not an
ACID transaction**, and a crash may leave both paths; replays can reconcile
matching revisions. A crash *during* destination write can leave a partial
collision requiring operator inspection; the source remains present. External
processes modifying a file concurrently during the final unlink have a
remaining check/use race that portable Node APIs cannot eliminate. Run the
sandbox with controlled exclusive ownership; worker durable leases (issue #10)
and Git branch-level compare-and-swap (issue #11) are independent requirements.
No private GitHub integration or production move is implied.

To validate in an installed workspace:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run docs:check
```

The conformance tests are defined in
`apps/worker/test/content-store-conformance.ts`, and the local suite in
`apps/worker/src/content-store/filesystem.test.ts`. GitHub adapter tests
should run the same suite with a deterministic fake fixture. The current
adapter has no live private-repository smoke test (not authorized by #7).


## GitHub ContentStore adapter (issue #11)

The optional `GitHubContentStore` at
`apps/worker/src/content-store/github.ts` implements the same port as the
filesystem adapter. The opt-in one-shot worker can select this adapter only after a separately verified private-repository acknowledgement, while public CI continues using an injected synthetic GitHub HTTP fake. No live content
repository was accessed for this implementation.

Server-only configuration (deliberately **not** placed in client bundles or PR
workflow secrets):

```dotenv
CONTENT_REPOSITORY=owner/verified-private-content-repo
CONTENT_BRANCH=main
CONTENT_GITHUB_TOKEN=<runtime-secret-injected-by-secret-manager>
```

Instantiate via `githubContentStoreFromEnv()` after **separately verifying**
the target repository is Private, or inject explicit constructor options and a
fake `fetch` for tests. The token must be granted to the configured content
repository with **Contents: read and write**; no Actions, Issues, Pull requests,
Secrets or administration permission is required. A GitHub fine-grained PAT can
be repository-scoped but cannot be restricted to only `inbox/` and `notes/`
paths; protect the credential as a repository-wide content write capability.
Use an installation token if the deployment supports its expiry and rotation
semantics. Credentials are carried only in the HTTP Authorization header.

GitHub revisions are immutable **blob SHAs**, unlike local SHA-256 revisions.
A transition reads a branch-head snapshot, creates a new Git tree with the
source deleted and destination referencing the same blob, creates a commit and
attempts a **non-force, fast-forward branch ref update**. If another writer
advances the branch, the adapter re-evaluates source/destination revisions
against the new head; it never overwrites a different destination or removes
newer source bytes. This is an atomic Git commit, not copy-then-delete; a
network timeout can leave an uncertain commit result, safely reconciled on
the next call. A matching destination plus original source is recoverable, and
a missing source plus matching destination means already finalized.

Pending discovery uses a bounded **seek cursor over the repository tree**
(default 50; maximum 100 per page), not a GitHub REST page number. The tree
API returns an entire recursive tree snapshot per scan, so costs grow with
repository size. GitHub's `truncated` response is **rejected**, not silently
treated as a complete scan. This implementation is appropriate to a small
personal repository and must be replaced with subtree-based scans when tree
limits become significant. Paths outside the approved inbox/notes/rejected
layout, nonregular Git objects and invalid/oversized UTF-8 Markdown are
rejected. Only files inside `inbox/` are discovered.

Transient request failures (network exceptions, 429, 5xx and documented
secondary rate limits) receive bounded retries with capped delay; HTTP
401/403 (other than explicit rate limiting) denies access. Errors are typed
without relaying content bodies, private URLs, tokens or API exception text.
Following retry exhaustion, the worker must record an error and retry at a
higher level later rather than discard the source. Branch-head conflicts are
retried up to four attempts before surfacing `REVISION_CONFLICT`.

**Manual private-repo smoke test — not performed:** first verify repository
visibility is Private and explicitly authorize synthetic-only external writes.
Then check list/read/finalize/replay/reject using a freshly generated disposable
synthetic note in a dedicated staging branch, with a repository-scoped token.
Inspect the final commit to confirm source deletion and exact destination
bytes; revoke the token and clean staging data. Never invoke that smoke test
from the public PR workflow, or upload a token or real note to CI.


## Deterministic ingestion pass (issue #10)

`runIngestionBatch` scans at most 500 inbox references per pass by default (hard maximum 1000) and processes at most 50 claimed revisions (hard maximum 100). Each `processing_attempts` row is unique on source path and source revision; the PostgreSQL conditional update owns a five-minute lease, 5-second-to-1-hour capped retry delay, structured error code and durable `PERSISTED` checkpoint. Expired leases can be reclaimed. A schema-validation error is stored in the durable `REJECTED` state **before** moving the source to `rejected/`; if the move fails or the process crashes, subsequent inbox scans reconcile the unchanged revision. Identity conflicts remain in the inbox for manual repair. Identity/source collisions remain in the inbox for manual repair, without overwrites.

After schema-v1 validation and the idempotent serializable Prisma upsert, the worker writes the `PERSISTED` checkpoint, then calls ContentStore finalization with the observed revision and only afterward marks both note and attempt `FINALIZED`. At the beginning of every pass, a reconciliation scan retries persisted attempts, including cases where an interrupted transition already moved the source out of `inbox/`. The canonical date is the captured **local** date, not the UTC conversion or reminder `due_at`. No notification, task, inferred deadline or LLM operation is performed.

The default `npm run dev:worker` remains an idle scaffold for safe developer startup. To run **one synthetic/local batch**, apply the DB migration, create an absolute disposable filesystem sandbox containing `inbox/*.md` files that pass the v1 validator, then run:

```bash
export DATABASE_URL='postgresql://pce:pce_dev_only@127.0.0.1:5432/pce?schema=public'
WORKER_MODE=once WORKER_CONTENT_BACKEND=filesystem \\
  WORKER_CONTENT_ROOT=/absolute/path/to/synthetic-sandbox npm run start -w @pce/worker
```

Build first with `npm run build`; schedule subsequent once-mode executions using an external, separately configured job scheduler. To opt into the GitHub-backed store instead, a trusted runtime **must** set `WORKER_CONTENT_BACKEND=github`, `WORKER_ALLOW_GITHUB_WRITES=I_VERIFIED_PRIVATE_REPOSITORY`, `CONTENT_REPOSITORY`, `CONTENT_BRANCH` and a server-only `CONTENT_GITHUB_TOKEN`. This string is an intentional operator acknowledgement, **not** a substitute for verifying privacy or permissions. Never configure the public CI with content credentials.

The PostgreSQL 16 integration job validates the synthetic filesystem path and crash/retry/concurrency cases. Real private GitHub writes, a device, persistent scheduler, process-kill testing at every instruction, and end-to-end private capture remain unverified. Lease expiry during a long content transition can permit concurrent recovery; the ContentStore's compare-and-swap semantics protect against overwritten revisions. As with any non-ACID Git/DB operation, an unrecoverable destination conflict requires manual inspection rather than destructive overwrite.

### Local activation (#40)

`npm run dev:local` with `PCE_INGEST_GITHUB=true` runs this actual worker
state machine on startup and every 30 seconds against the explicitly
configured verified private GitHub repository. It persists before committing
canonical moves, fast-forwards the local checkout, refreshes browsing and
exposes sanitized pass status in the local UI. Retry/rejection records remain
durable. The default standalone worker is still idle; this local polling loop
exists only while the developer process is running. See the operations guide
for credentials, checkout validation and preview revision bridging.

## Two-input, database-first ingestion contract (accepted target; #43, #45, #56, #61)

**Current implementation (do not regress):** private GitHub `inbox/` -> deterministic worker -> PostgreSQL projection -> GitHub `notes/YYYY/MM/` source-file finalization. The opt-in local poller (#40) runs only with the local process. Source finalization currently **writes to GitHub**; target read-only ingestion is a future implementation change under #43 and must not be asserted as shipped.

**Future GitHub input adapter:** accept independent Markdown v1 GitHub captures while API/MCP or the worker is offline. When running, periodically scan/reconcile a bounded repository change history or source state. Webhooks can reduce latency but are not sufficient for correctness. Validate originals and attribution, idempotently persist/associate verified owner, stable capture/note IDs, source Git revision and import result in PostgreSQL, and atomically enqueue durable DB processing work. Advance a persisted import cursor only after DB commit; on failure, retry/replay the same revision safely. Handle changed/deleted/renamed files, truncated scans, token failure and owner conflicts explicitly without silently removing stored source data. Surface import lag, last successful checkpoint and unreconciled/rejected input status.

**Future direct API/MCP input:** verify user identity/scope and the versioned capture; persist original bytes/meaning, IDs, provenance, authenticated owner, idempotency key and pending downstream jobs in a **single DB transaction**. A successful API reply means `DB_PERSISTED`; it may separately report `INDEX_PENDING` or `LEDGER_PENDING`. It does **not** imply a GitHub file exists and must never require a GitHub export outbox. If API/DB is unavailable, reject safely, never claim a successful save. GitHub-origin captures still work independently through the connector.

**Post-ingestion workers:** claim leased/retryable PostgreSQL jobs for embeddings, aggregation, source-linked ledgers and similar enrichment; query originals from DB and store resulting state/artifacts in DB. No worker processing queue, mandatory derived Markdown or write-back in GitHub. Provider failures keep durable originals and permit bounded retry/rebuild. Synthetic tests must prove idempotency, replay, multi-tenant isolation, stuck-job recovery and no re-import loops.

**Disaster recovery and migration:** direct-input notes and derived results may only exist in PostgreSQL. Backup/recovery automation (#61) is deferred under D-020 and is not a functional delivery prerequisite; the existing synthetic drill remains optional. Test catch-up against GitHub after restoring the DB without duplicating input or overriding authenticated ownership. Retire GitHub file-finalization writes only after a separate migration/reconciliation PR, preserving source revision integrity and current connector usability. Search remains repo-first until the independent #50/#56 cutover gate. See [13 — Evolution plan](13-evolution-plan.md).


## Durable local reconciliation (#43)

**Implemented:** opt-in local polling keeps a PostgreSQL `ingestion_checkpoints`
row scoped by a SHA-256 of backend, repository, branch and trusted owner. The
standalone GitHub once-mode worker also verifies private visibility at runtime
and persists its own unowned scan scope. Default worker startup stays idle.
This is still the existing GitHub-finalizing projection, not the future read-only
GitHub importer or a DB-job enrichment pipeline.

Each bounded worker pass resumes a seek cursor, recording progress only after
visited source revisions have durable attempt/import results. A checkpoint is
**discovery progress**, not proof that every file imported: rejected inputs,
retry state and leases remain in `processing_attempts`. A DB failure before
checkpoint commit replays the old page. Version compare-and-swap prevents an
older concurrent scan from replacing newer progress. End-of-scan resets the
cursor so files inserted/changed before it are found on a later pass, without
webhooks. Existing persisted-attempt recovery runs independently of that cursor.

After each GitHub pass the local launcher fast-forwards the checkout and scans
its current inbox/canonical sources. Only after successful DB imports and a
stable, clean Git snapshot does it record the observed Git revision and, when
there are no current conflicts, missing sources, invalid inputs or deferred/
retry/rejection outcomes, the reconciled revision/time. This describes the
current source snapshot, not every historical Git commit or resolved rejection.
An observed revision can remain ahead of reconciliation; timestamps expose
staleness without publishing private repository URLs, note IDs, cursor paths or
Git revisions through the local status endpoint. A later poll detects changes
that arrive after the snapshot.

Changed note text under an existing ID requires deliberate revision repair;
imports never silently overwrite it. Such projection conflicts are counted and
excluded from the new readable snapshot while independent valid files continue.
Previously seen note IDs remain in the checkpoint, so missing/deleted sources
stay visible across restarts; DB originals are retained and never deleted.
Restoring the source resolves the missing count. A canonical move preserving the
ID is not a deletion. Unsupported renames, duplicate IDs, symlinks, dirty or
divergent checkouts fail closed; previous readable state remains until repair.
Invalid captures remain in source/rejected storage with durable validation
errors. Neither missing counts nor tags execute an external action.

### Trusted local operation and scheduling

1. Use a single configured content repository per local database/checkout (the
   legacy note/attempt tables are not a multi-repository namespace). Verify
   private visibility, a clean matching checkout/branch and scoped credentials.
2. Run `npm run dev:local` with the existing ignored server-only `.env`,
   `DATABASE_URL`, `PCE_INGEST_GITHUB=true`, `CONTENT_REPOSITORY` and
   `CONTENT_BRANCH`. The launcher builds and deploys additive migrations, then
   checks immediately and every 30 seconds. Keep services on loopback.
3. Open the local web UI's ingestion status. `lastRun` means the source check
   finished; `checkpoint.reconciledAt` means a clean reconciliation finished.
   Inspect conflict/missing/invalid counts and fixed error status. No timestamp
   implies continuous availability. Stopping the launcher stops polling.
4. During downtime GitHub capture remains independent. Restart the same command
   with the same DB and checkout to resume bounded scanning, recover durable
   attempts and rescan current source state. No webhook delivery is required.
5. For a separately managed trusted scheduler, the existing GitHub
   `WORKER_MODE=once` entry point can be invoked repeatedly with its explicit
   private-write opt-in. Prevent overlapping scheduled invocations; supply
   secrets in the runtime environment, never command arguments or public CI.
   It persists scan progress but does not perform the local web snapshot/status
   refresh. There is no hosted scheduler, launch-at-login service or production
   deployment installed by this change.

Synthetic PostgreSQL tests cover scan-limit/restart continuation past poison
inputs, scan wrapping, checkpoint stability on DB failure, durable commit/move
recovery and replay. Snapshot tests cover conflicts, missing IDs across restarts
and transient failures. Public CI uses no real repository or provider secrets.
For a trusted acceptance check, restart the local launcher, verify a clean
reconciliation, restart again and confirm no duplicate imports/finalization;
inspect **counts only**. Use a separate staging branch/database and synthetic
notes for deliberate delete/rename/conflict or crash experiments.

Rollback: stop the launcher, revert the code and restart the previous version.
The additive checkpoint table is harmless to old code; retain it for recovery.
To reset a scan, stop all workers and set only that scope's cursor to NULL in a
trusted DB session; never delete notes/attempts to force a replay. Do not clear
known IDs to hide an unresolved source deletion. Backup automation #61 remains
deferred under D-020 and is not activated here.
