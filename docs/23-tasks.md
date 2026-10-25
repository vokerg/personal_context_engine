# 23 — Independent Tasks

Epic [#147](https://github.com/vokerg/personal_context_engine/issues/147) defines
first-class Tasks. The #148 slice implements durable creation, lifecycle, API,
history and shared client contracts. Extraction, private GitHub task artifacts,
task search/MCP, web/iOS views and live acceptance belong to #149–#154; they are
not delivered by the foundation.

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
| `GET /api/v1/tasks` | `tasks:read` | `status=OPEN` (default), `COMPLETED` or `ALL`; `limit` 1–100 (default 30); optional `after` from `nextCursor` |
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
