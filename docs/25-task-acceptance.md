# Task acceptance and release gate (#154)

## Owner-approved activation checkpoint (2026-10-26)

Implementation #155–#161 and private companions are merged. Hosted API/web,
trusted local GET-only importer, fresh Task scopes, actual NOTES notes-v3.0 and
private plugin 0.2.0 are enabled and exercised with synthetic records. Native
Release compilation/install, real simulator auth/session and Task workflows
were observed. See [the executed live matrix and limits](evidence/issue-154/2026-10-26-activation.md).
The preparation/reproduction sections below retain their historical default-off
boundary; defaults stay off in code. This checkpoint does not claim physical
iPhone, microphone, VoiceOver or forced live outage acceptance.

The #147 implementation is a sequence of independently reviewable changes.
Local mechanisms and synthetic acceptance do not establish a production release.
All Task flags remain off by default; no live prompt, plugin release, OAuth
registration or deployment is activated by these PRs.

## Reproduce synthetic acceptance

Use Node/npm from `.nvmrc` and `package.json`, a clean checkout without dotenv
files and disposable PostgreSQL 16 with pgvector. Create the database with a
UTF-8 locale supporting English/Russian text (for example `en_US.UTF-8`), then:

```sh
npm ci --no-audit --no-fund
PCE_DB_TEST_URL='postgresql://pce_test:synthetic_only@127.0.0.1:5432/pce_test?schema=public' npm run tasks:verify
```

The command builds shared packages/API/worker, applies the checked-in migrations
twice, verifies schema drift and runs selected contract, repository, authenticated
HTTP/official MCP client, importer, typed-client, web and native synthetic suites.
It requires an explicit loopback `pce_test` or `pce_tasks_*` database, rejects
remote/ambiguous datasource overrides, refuses local dotenv files and constructs
a child environment without inherited service credentials or runtime flags.
Database migrations run from a temporary schema directory. Database rows are
synthetic; individual suites clean their own records. No external model/provider,
GitHub account writes or real personal content is needed. It does not drop/reset
the database and does not start an application or enable runtime gates.

For the broader regression suite, run `npm test -- --no-file-parallelism` with
both `DATABASE_URL` and `PCE_DB_TEST_URL` explicitly targeting that disposable
database. Also run lint, typecheck, format and docs checks. These are separate
from manual host/device acceptance. The existing least-privilege PostgreSQL CI
includes the combined HTTP acceptance test.

### Recorded local results (2026-10-25)

Executed from an isolated worktree against a Unix-socket-only disposable
PostgreSQL 16.15/pgvector database with `en_US.UTF-8` locale:

- `npm run tasks:verify`: all seven steps passed, 18 migrations reconciled twice,
  no schema difference, **17 files / 112 tests passed**.
- Full `npm test -- --no-file-parallelism` with explicit synthetic DB URLs:
  **90 files / 456 tests passed** (build included).
- `npm run lint`, `npm run typecheck`, `npm run format:check`,
  `npm run docs:check`: passed (204 local documentation links).
- Earlier native slice: iOS JavaScript export passed (731 modules). This is not
  native compilation, installation or device acceptance.

The initial #148 run in a `C`-locale database exposed an existing Cyrillic search
fixture mismatch; the UTF-8-locale rerun passed. The initial #152 broad run lacked
an Expo crypto mock in a shell SSR test; the corrected test rerun passed. Neither
failure is treated as a successful run. Live/manual checks below remain pending.

## Observable coverage

| Boundary | Evidence and limit |
| --- | --- |
| Domain/schema/lifecycle | [DB tests](../packages/db/src/tasks.integration.test.ts): real PostgreSQL, owner isolation, source checks, conflicts, atomicity, stable IDs, durable commands, exact retries and completion/reopen history. Migrations are additive; rollback disables exposure while retaining data. |
| Extraction and ingestion | [Ingress tests](../apps/worker/src/task-ingress.integration.test.ts): synthetic private-store adapter, batch before parent, deferred recovery, checkpoint reconciliation, invalid artifacts and cross-channel replay. No worker model inference. |
| Policy 0/1/3 and languages | [13-case matrix](../packages/db/src/task-policy.integration.test.ts) and [fixtures](../test/fixtures/task-policy-v1.json): supplied human-authored outputs preserve one original and exact evidence. This is **not live model classification**. |
| API, scopes and MCP | [HTTP/OAuth](../apps/api/src/tasks.integration.test.ts), [official MCP client](../apps/api/src/mcp.integration.test.ts): independent scopes, consent, owner isolation, safe errors, lifecycle and source visibility. Actual ChatGPT attachment remains pending. |
| Search | DB/MCP suites cover Task-only Open/Completed/All, English/Russian retrieval, stable pages, authorized source context and removed-source suppression. No Task embeddings or Note-search cutover. |
| Combined source and rollback | [Acceptance test](../apps/api/src/task-acceptance.integration.test.ts): typed client → authenticated HTTP → DB; three Tasks, complete one, Note archive/removal, source search suppression, gate disable/reactivation, batch replay and reopen. Original body/text/hash and Task history survive. |
| Web | [Components](../apps/web/src/TasksPanel.test.tsx) plus [actual browser evidence](evidence/issue-151/browser.md): one-of-three completion after acknowledgement, retry/conflict behavior, reopen, provenance and desktop/narrow dark layout. Manual light mode/assistive technology remain pending. |
| Native | [Request model](../apps/mobile/task-requests.test.ts), [screen](../apps/mobile/task-screen.test.tsx), session/navigation/tab suites and an iOS JavaScript export. Native compilation, installed app, Keychain, simulator/device, VoiceOver and background/restart behavior remain pending #131. |
| NOTES/plugin | [Shared policy](24-task-extraction-policy.md), [integration audit](../integrations/conversation-capture/README.md), inactive private prompt and local archive candidates. No installed Project-settings or released plugin claim. |

## Review and release order

The public stack is #155 (schema/API) → #156 (extraction/import) → #157
(search/MCP) → #158 (web) → #159 (iOS) → #160 (policy/candidates), followed by
this #154 acceptance change. Each PR targets its immediate dependency. After
each authorized upstream merge, rebase/retarget the next PR to current `main`
and rerun required checks before considering it mergeable. Private companion
[contract PR #6](https://github.com/vokerg/personal_context_engine_content/pull/6)
precedes [inactive prompt PR #7](https://github.com/vokerg/personal_context_engine_content/pull/7).
An agent self-review does not replace independent review or explicit human
authorization for each merge.

After owner release go/no-go, use a synthetic identity and fresh consent to
verify deployed API/import readiness before installing any extraction candidate.
API Tasks use `PCE_TASKS_ENABLED`; GitHub ingress separately uses
`PCE_TASK_INGRESS_ENABLED` and its scoped configuration. Web uses
`VITE_PCE_TASKS`; native uses `EXPO_PUBLIC_PCE_TASKS` and requires a new build.
Do not widen existing grants: request/consent to `tasks:read`/`tasks:write` and
`notes:read` only as needed. Existing capture/search paths remain working.
See [operation and scope details](23-tasks.md).

The remaining manual gates are tracked in #153/#154 and native #131:

- Independent review, per-PR merge authorization, correct base and required CI.
- Owner-authorized deployed synthetic API/MCP and GitHub ingress readback,
  retry/partial failure and owner isolation; no personal-note writes.
- Actual ChatGPT connector/tool availability and granted scopes. NOTES candidate
  installation in Project settings must be observed separately from a repository
  merge. Text/voice 0/1/3, opt-out, ambiguity and partial receipt tests must use
  synthetic input. Record exact prompt/plugin versions and real results.
- Owner-approved plugin publication/installation, refreshing the expected-release
  guard first. Prepared 0.2.0 ZIP is not an installed release.
- Actual iPhone/simulator acceptance integrated with #131: fresh auth/logout,
  existing secure session, one-of-three completion, reopen, source navigation,
  tap latency, offline/timeouts, restart, light/dark, font/safe areas and VoiceOver.
  Preserve the owner's existing simulator login; do not overwrite its Keychain.

No issue/epic completion or production acceptance is claimed while these remain.
Backup automation #61 remains deferred under D-020 and is not a release blocker.

## Reversible rollback

Disable Task ingress first if extraction/import is suspect, restore the exact
previous installed NOTES/plugin version, and disable Task client/server gates
as needed. Existing Note capture/retrieval continues independently. Keep the
additive tables, originals, batch receipts, command receipts and Task events;
do not drop data to hide a feature. Re-enable only after fixing the verified
failure, then reconcile/replay the same IDs. Exact batch replay must retain
completed status; an explicit newer lifecycle command is required to reopen.
The combined acceptance test demonstrates this local rollback/reactivation
boundary. It does not claim a deployed rollback or a destructive down-migration.
