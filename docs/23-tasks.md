# 23 — Independent Tasks

Epic [#147](https://github.com/vokerg/personal_context_engine/issues/147) defines
first-class Tasks. The #148 slice implements durable creation, lifecycle, API,
history and shared client contracts. The #149 slice adds extraction contracts
and gated private GitHub artifact import. The #150 slice adds dedicated Task search and scoped MCP tools.
The #151 slice adds the gated web workspace. The #152 slice adds native iOS Tasks behind a build flag. Prompt activation
and actual cross-surface release acceptance remain #153/#154.

## Record and source boundaries

A Task has its own stable UUID/ULID, owner, title (1–200 characters), optional
description (at most 8,000), origin, creation hash, revision, status and timestamps.
It can stand alone or link at most 20 Notes with their verified capture IDs.
One Note can support many Tasks without duplication or metadata changes.
`kind: task`, `task` tags and action hints never create Task rows.

Source relationships preserve exact optional evidence (at most 2,000 characters,
required to occur literally in the original input). Composite SQL foreign keys
bind Task and Note owners and the Note's capture ID. Unknown, removed, unowned,
foreign or mismatched sources cannot be used for a new Task. Notes are not
rewritten. Sources remain linked when Notes are archived. When a Note is hidden,
its link/evidence is suppressed in Task responses; `unavailableSourceCount`
explains the missing link. Tasks, their own text and history remain available to
the Task owner. This is workspace hiding, not erasure. Hard deletion of linked
Notes/Tasks is restricted; no deletion endpoint or migration of existing content
is included.

## Lifecycle and retry contract

Tasks start `OPEN`, revision 1, with a `CREATED` event. Completing sets
`COMPLETED`, stores `completedAt` and adds a `COMPLETED` event; reopening clears
the current completion timestamp and adds a `REOPENED` event. Events survive.
Every changed state increases revision once. Completed Tasks disappear from
the default Open list and remain in Completed/All; no Note archive flag changes.

Creation is idempotent by stable `taskId` plus canonical immutable creation
payload. Reusing an ID with changed data conflicts. A bounded shared repository
operation creates up to 20 Tasks transactionally (zero is valid). Identical
creation replay returns current lifecycle state and never resets it, including
after completion or reopen. Ingress adapters share this operation; origin records
the first accepted path, and does not change the payload identity.

Every state command supplies a stable `commandId`, `expectedRevision` and desired
`status`. Serializable transactions and compare-and-swap enforce one winner for
distinct concurrent changes. Replaying an accepted command is a no-op even after
later transitions, and returns **current** state with `replayed: true`; reusing a
command ID with different data conflicts. A new command for the existing state
with the correct revision is a no-op with its own durable retry receipt. It
creates no event or revision. Clients retain the same command after a timeout;
a conflict requires reloading and a deliberate new command.

## Gated HTTP surface

`PCE_TASKS_ENABLED=true` explicitly enables these routes in the normal API entry
point. It defaults off and requires a live DB plus configured single-user
sessions. Trusted test adapters can inject the repository directly. No importer,
model request, provider charge, reminder, notification or external action runs.

| Route | Required scope | Contract |
| --- | --- | --- |
| `GET /api/v1/tasks` | `tasks:read` | `status=OPEN` (default), `COMPLETED` or `ALL`; `limit` 1–100 (default 30); optional `after` from `nextCursor` and `q` (1–500 characters) |
| `GET /api/v1/tasks/:id` | `tasks:read` | Individual Task with currently visible source links |
| `POST /api/v1/tasks` | `tasks:write` | Strict `taskId`, `title`, optional `description` and `sources`; receipt confirms `DB_PERSISTED` |
| `PATCH /api/v1/tasks/:id` | `tasks:write` | Strict `commandId`, `expectedRevision`, `status`; response has Task, `changed`, `replayed` |
| `GET /api/v1/tasks/:id/events` | `tasks:read` | Ascending revisions; `afterRevision` default 0; `limit` 1–100; `nextRevision` for next page |

Task pages sort by immutable creation instant then ID, descending. Anchors are
looked up under the verified owner even if their status changed. Pagination is
live: concurrent state changes may move records between filtered views; reload
after a mutation. A cursor is not authorization. Unknown/foreign anchors return
the same invalid-cursor response. Detail/mutation/history use indistinguishable
404s for unknown and foreign Tasks. Other outcomes: 401 missing/invalid auth,
403 insufficient scope/CSRF, 400 invalid input and 409 stale revision/ID conflict.
Request logging is disabled and responses are no-store.

Task scopes grant no Note access. Returning Note IDs, capture IDs or source
evidence additionally requires `notes:read`; creating a source-linked Task also
requires that scope. Browser owner sessions retain Origin/CSRF enforcement.
Delegated OAuth clients must explicitly register and request `tasks:read` and/or
`tasks:write` and pass new consent. Existing grants remain unchanged; refresh
cannot add scopes. The consent page explains Task record mutations. This slice
does not add an MCP tool or alter `capture_note`.

## Verification and rollback

Synthetic tests cover one Note/multiple Tasks, direct creation, owner/FK
isolation, grounded evidence, concurrent creation and state commands, stale
revisions, accepted-command replay after reopen, source archive/removal,
pagination, history, HTTP scopes/CSRF/validation and consent. Run with an explicit
disposable `PCE_DB_TEST_URL`; public CI uses its synthetic pgvector PostgreSQL 16
service. Never point tests or migrations at a personal database.

Disable the flag to withdraw HTTP routes; existing records/history stay durable.
The additive migration does not backfill or alter Note content. Retain the
tables on rollback: dropping them would destroy Tasks and audit history. Future
artifact/import recovery and cross-surface acceptance are separate child issues.

## Complete extraction and dual ingress (#149)

`TaskExtractionBatchSchema` is a **separate JSON v1** contract, at most 65,536
UTF-8 bytes. It has `schemaVersion: 1`, stable `batchId`, verified `captureId`,
1–20 distinct `sourceNoteIds`, truthful `classifier` metadata (`method: llm` or
`explicit`, `policyVersion: tasks-v1`, bounded agent/optional model), and 0–20
distinct Tasks using the foundation creation schema. Every extracted Task must
have at least one source quote that occurs literally in the original input;
all source IDs must belong to the listed Notes and capture. A zero-Task batch
is valid and may explain unclear task intent with `zeroTasksReason` (<=500
characters). Unknown fields, reminders/dates, duplicate Task/source IDs,
missing evidence, foreign capture references and oversized artifacts fail.

One immutable complete batch is allowed per owner/capture. Retain exact batch,
Task IDs and full extraction across retries; do not rerun classification to
repair a transport failure. Reordered file arrival is safe. Changed payloads
(including reordered extraction arrays), a replacement batch ID for the same
capture or a conflicting Task ID return a conflict and require reconciliation.
No new batch silently replaces a zero-Task result. Re-extraction/revisions are
not supported by v1. Provenance/model fields are descriptive, never execution
policy. The deterministic worker does not classify text or call an LLM.

`POST /api/v1/task-batches` is enabled with the same default-off HTTP Task gate.
It requires both `tasks:write` and `notes:read`, uses verified owner/CSRF checks,
and accepts only the batch body. `saveTaskBatch` is the shared typed client.
The receipt returns `DB_PERSISTED`, `batchId`, `taskIds` and `replayed` (plus a
zero-Task reason where supplied); it is independent from the Note receipt.
All Tasks, source links/events and the immutable batch receipt commit in **one
serializable transaction**. A late collision rolls everything back. Replaying
through either ingress returns the same identity without resetting completion.
Source Notes must already be visible to that owner with the matching capture;
missing, removed or foreign sources return the same generic source-unavailable
response. A committed receipt can still replay after source removal.

### Optional private GitHub inbox

The only Task artifact path is `tasks/inbox/<batch-id>.json`. The filename must
match the validated batch ID. No ordinary Markdown v1 finalization, historical
Note edit, completion-file write, export or GitHub outbox is added. The private
contract is a separate reviewed documentation PR; its inline examples are
synthetic and are not actual inbox files. Prompt activation remains #153.

The **existing** `db-jobs-once` / `db-jobs-loop` worker accepts an independent
`PCE_TASK_INGRESS_ENABLED=true` gate plus `PCE_TASK_INGRESS_REPOSITORY`,
`PCE_TASK_INGRESS_BRANCH`, `PCE_TASK_INGRESS_TOKEN`, trusted `PCE_OWNER_SUBJECT`
and `DATABASE_URL`. Prefer a separate Contents:read token. The Task adapter
verifies private visibility at discovery/read, makes GET requests only, pins
reads to the observed commit, rejects symlinks/truncated trees/unsafe paths,
and bounds raw bytes. Research ingress enablement does not enable Task ingress.
The default worker remains idle; the HTTP gate does not start this reader.

Each pass scans up to 50 artifacts (configurable test/service limit 1–100).
Repository/branch/owner-scoped checkpoints advance after each visited page and
wrap after a full sweep, recovering missed events, restarts and delayed source
Notes. Durable per-path/revision observations distinguish `IMPORTED`, `RETRY`
and terminal `INVALID`. Backoff grows from 10 seconds to one hour. Missing
sources, changed/unavailable reads and DB failures retry; malformed/unsafe or
conflicting artifacts are preserved and marked invalid. Changed file revisions
are revalidated. The DB batch/Task transaction is authoritative if a process
crashes before recording the import observation; retry only replays it. Logs
contain counts and fixed codes, never source text, paths, credentials or errors.

### Non-atomic capture and rollout

A GitHub Note and its Task artifact are two separate writes. Validate/create/read
back Note(s) first; verify exact source/capture IDs and original evidence, then
validate/create/read back the complete Task batch. Report Note success, Task-file
success and DB receipt separately. If the batch fails, retain the Note and the
unsaved batch's IDs: “Note saved; Tasks not saved”. On uncertainty inspect the
same path; matching content reuses the receipt, differing content conflicts.
Never create replacement IDs or a duplicate Note to bypass a failed write.
A file receipt means “Task batch saved; DB import pending”; only DB evidence
proves Task persistence. A batch arriving first defers without creating Tasks.

Rollout requires public and private PR review, explicit worker/API configuration,
and the later owner-approved prompt. No real content migration or provider spend
was performed. Disable either independent gate to withdraw that path; keep
batch receipts, Tasks and events. Prompt rollback or ingress disablement cannot
remove Tasks or erase completion history. Live hosted/Project acceptance is
separate from synthetic PostgreSQL and fake-GitHub tests.

## Task-only search and MCP (#150)

The shared `getTasks` HTTP client passes `q` to the owner-scoped Task repository.
PostgreSQL English/Russian stemming, simple token/literal matching and explicit
alphanumeric identifier boundaries reuse the existing lexical helpers. Matching
uses Task title/description plus visible source Note titles, summaries and
stored evidence only when the verified grant includes `notes:read`. Task-only
grants search their Task text and receive no Note evidence/IDs. Removed/foreign
Note context cannot contribute; archived Notes can still provide authorized
context. Returned source links include `capturedAt` from the Note, separately
from Task `createdAt` and `completedAt`.

Results are Task records in stable creation-time/ID order, with bounded live
pagination and immediate OPEN/COMPLETED/ALL filtering. They are never a
`kind: task` Note search or a filtered window of Note hits. No task embedding,
provider call, reindex, Note ranking change or retrieval cutover is added.
Empty results are an empty Task page. Literal identifier constraints and shared
lexical fallback semantics are inherited; there is no semantic paraphrase claim.
Query text appears in the authenticated GET URL and is not placed in shared
browser navigation/storage or logs. Clients should use the shared encoded client.

The independent gate also injects the Task service into optional MCP. Task read
scopes expose list/search/get/history; Task write scopes expose explicit create
and complete/reopen, and with Note permission the supplied-batch save tool.
See [MCP authorization and tool contract](18-mcp.md#optional-task-tools-150).
Existing Note tools and `capture_note` schemas remain unchanged. Synthetic
PostgreSQL and official MCP client tests cover multilingual queries, identifiers,
pagination, completion history, owner/scope isolation and source removal; live
ChatGPT usage is a separate release gate.

## Web Tasks workspace (#151)

`VITE_PCE_TASKS=true` adds Notes/Tasks navigation to the existing web app. The API
Task gate is independent; production builds need the explicit public flag.
`dev:local` injects the matching flag only with explicit local sessions and the
server Task gate; ordinary development Vite configuration also infers it. No
private token/configuration enters this public flag. Defaults stay off.

The Task workspace offers Open, Completed and All, dedicated server search,
bounded Previous/Next pages, full Task description/provenance, paged lifecycle
history and authorized source Note navigation. It keeps query/page/selection in
memory when switching to Notes and back, and clears on session removal. Search
text and Task bodies are not saved in shared URLs or browser storage. Source
Notes are independently fetched/authorized through the existing Note reader.

Completion/reopen waits for the server; the Task row is not marked completed
optimistically. Duplicate taps are blocked synchronously. Network uncertainty
retains the exact command for an explicit retry; a stale revision reloads the
view and requires a new deliberate change. Confirmed completion leaves Open,
remains in Completed/All and preserves the Note. Keyboard focus returns to the
list heading after confirmation. Auth/offline/not-found failures expose safe
messages, with retry/reconnect guidance, never raw provider/network exceptions.

Explicit standalone Task creation uses one generated stable ID, title and optional
description. After an uncertain response, inputs remain fixed and retry reuses
that ID/payload. The pending request is in memory, not a durable offline queue;
a reload/logout requires inspecting the server list before manually recreating
anything. Existing Task title/description editing is not implemented; the API
currently supports lifecycle changes only. No Note opening/tag creates Tasks.

UI components use native checkbox/button/form semantics, responsive columns and
the existing system light/dark palette. Synthetic typed-transport component tests
cover one-of-three completion, archive/reopen, source retention, literal rendering,
search/pages, duplicate taps, conflicts, stable mutation/creation retries and
401/403/404. [Browser evidence](evidence/issue-151/browser.md) records actual
synthetic desktop/narrow checks and remaining live acceptance limits.

## Native iOS Tasks (#152)

The existing React Native/Expo app has an independently gated native Tasks tab,
virtualized server-backed Open/Completed/All/search, checkbox completion/reopen,
source Note navigation, paged detail/history and explicit standalone creation.
The Note source opens through the existing authenticated navigator; Back returns
to the mounted Task view. Task status does not archive the Note or create a
Reminder. Deterministic capture never runs an LLM or fabricates a commitment.

`EXPO_PUBLIC_PCE_TASKS` defaults false. An enabled build requests explicit
`tasks:read` / `tasks:write` scopes alongside existing native permissions, subject
to operator registration and fresh OAuth consent. Existing credentials/refresh
are not upgraded. Secure-store and logout behavior stay in the existing native
session boundary; Task state and pending requests are memory-only. API scopes,
source access and CAS/idempotency are enforced server-side as on web/MCP.

Native controls wait for acknowledgement, synchronously block duplicate presses,
retry exact cached requests after uncertainty and reload stale revisions for a
new decision. Error messages distinguish expired/missing access, unavailable
Tasks and connectivity without private exception text. Read requests cancel
when their context changes; old pages/detail cannot replace a later query.

The normal Expo/iOS SDK, palette, menu fallback and keyboard/text controls are
reused. Synthetic native component/transport tests and iOS JS export pass; actual
native compilation, device/simulator, VoiceOver/font/safe-area/auth/background
checks are **not inferred** and remain #131/#154. See
[native configuration and limits](../apps/mobile/README.md#optional-native-tasks-152).

## Capture integration candidates (#153)

[Shared tasks-v1 policy](24-task-extraction-policy.md) is the single classification
authority for NOTES and conversation capture. Clear grounded user commitments
can become 0..N independent Task records after activation, without per-task
approval. Speculative/quoted/unaccepted ideas remain Notes; explicit no-Task
opt-out skips the batch. Task creation never authorizes dates/reminders or
external execution. The importer/API remain deterministic.

A private notes-v3.0 candidate and a separately prepared conversation-plugin
0.2.0 archive are reviewable but **inactive**. Working prompt/settings and
installed plugin remain unchanged. Current plugin source has no own server;
actual absent write tools use the reviewed GitHub batch path after activation.
See [Project acceptance](12-chatgpt-project.md#first-class-task-integration-candidate-153)
and [integration audit](../integrations/conversation-capture/README.md).

The 13-case supplied-output persistence matrix validates exact originals and
0/1/3/EN/RU/mixed/opt-out/unclear/quoted outputs through replay; it is not an LLM
classification test. Actual publication/installation, deployed write readiness,
consent, one-send voice/text and device acceptance remain #153/#154, requiring
owner go/no-go before production prompt mutation.

## Consolidated acceptance (#154)

Run `npm run tasks:verify` from an isolated checkout with an explicitly configured
disposable local `PCE_DB_TEST_URL`. The command builds the relevant packages,
checks migration replay/schema drift and runs cross-surface synthetic suites.
The combined authenticated HTTP/typed-client test covers three independent Tasks,
one completion, source archive/removal and reversible feature disable/reactivation
without changing originals or history. See [acceptance and release gates](25-task-acceptance.md)
for reproduction, review order and the actual native/host checks still required.

### Approved live activation (2026-10-26)

The owner approved enabling hosted API/web Tasks, the separate trusted local
Task importer, fresh ChatGPT/native Task scopes, NOTES notes-v3.0 settings and
the private conversation plugin 0.2.0. Actual 0/1/3 captures, deployed web/native
lifecycle/source preservation, native Release installation and session checks
are recorded in [the live evidence](evidence/issue-154/2026-10-26-activation.md).
Earlier default-off/candidate statements describe preparation; public/default
startup stays off. Physical-device, VoiceOver/audio and forced live outage checks
remain explicitly unverified. Existing Note capture/search remains independent.
