# 15 — PostgreSQL recovery gates

## Status and operator entry point

Issue [#64](https://github.com/vokerg/personal_context_engine/issues/64) implements
an isolated, synthetic recovery drill for the **current projection schema**.
Parent [#61](https://github.com/vokerg/personal_context_engine/issues/61) remains
open. No production backup schedule, encrypted archive storage, provider PITR
configuration, owner export endpoint or live recovery has been activated.

From the public mechanism checkout, install dependencies and generate the client
(`npm ci`, `npm run prisma:generate`). Install PostgreSQL **16 server and client
binaries**, including `initdb`, `pg_ctl`, `createdb`, `pg_dump` and `pg_restore`.
Run as an ordinary user on macOS or Linux:

```sh
npm run db:recovery:drill
```

If those binaries are outside PATH, use the directory override. For a Homebrew
PostgreSQL 16 installation:

```sh
PCE_PG_BIN_DIR=/opt/homebrew/opt/postgresql@16/bin npm run db:recovery:drill
```

The command accepts **no database URL or positional arguments**. It creates a
private disposable directory under `/tmp`, a Unix-socket-only PostgreSQL cluster,
and separate source and restore databases. Subprocesses get an environment
allowlist; Prisma migrations run from a temporary schema copy outside application
`.env` discovery. Both Prisma clients receive explicit disposable database URLs.
The generated Prisma runtime can still discover the checkout `.env`; its database
credentials are overridden and never used as a target. Inherited DB/provider
credentials are not passed to subprocesses.
No private checkout, network listener, hosted database or external API is used.
The local preview/worker can keep running during the drill.

The custom-format archive contains **only generated synthetic data**. It is
mode 0600 inside a mode 0700 directory and is removed with the cluster on normal
success/failure. SIGINT/SIGTERM request cleanup; a forced kill or machine crash
can leave synthetic artifacts under `/tmp/pce-recovery-synthetic-*`. Inspect the
specific cluster's PID before stopping it; never broadly kill PostgreSQL or
remove an unidentified data directory. Failed cleanup makes the command fail.
This synthetic archive is deliberately unencrypted and is **not** a production
backup tool. Do not adapt the command to point at private data.

## What a passing drill proves

1. Apply checked-in migrations to a new source database; seed two owners,
   Unicode/multiline originals, stable IDs, provenance/revisions, an interrupted
   PERSISTED attempt with an expired lease and a delayed RETRY attempt.
2. Dump the source and restore transactionally into a separate empty database.
   Compare **all columns** of `captures`, `notes`, `processing_attempts` and
   `_prisma_migrations`, including timestamps, original text, hashes and links.
   An unexpected public table fails the drill until coverage is extended.
3. Resume the real ingestion worker through its synthetic filesystem adapter.
   Recover the expired lease, retry the pending source and discover a new input.
   Replay both importer and worker; verify no duplicate captures/notes and exact
   finalized source file bytes. Preserve the other owner's row and reject an
   import that attempts to reassign it.
4. Preserve a DB-only fixture with no corresponding source file. This demonstrates
   recovery independent of GitHub; it does **not** exercise a future API/MCP capture
   endpoint. Disconnect clients, stop the cluster, delete the archive and emit a
   content-free JSON result. The timing measures synthetic dump/restore/comparison,
   excluding operator response and production-scale recovery.

Current tables store parsed original text/body and the current source revision;
they do not promise a full raw Markdown archive or an immutable revision history.
Restoration preserves what the schema actually stores. The filesystem adapter
exercises ingestion state transitions, not live GitHub transport, Git revision
checkpoints, renamed/deleted files or an inbox already moved ahead of the backup.
No HTTP authorization/cross-owner read claim follows from an import conflict test.

## Proposed production recovery policy — review before activation

These are proposed engineering targets, **not current guarantees or a purchased
hosting plan**. Record the accountable operator, actual storage region, data size,
measured completion times and approved retention before enabling DB-primary use.

| Control | Proposed gate |
| --- | --- |
| RPO (maximum committed data loss) | At most 24 hours from independent logical backups; target at most 5 minutes using verified provider PITR/WAL coverage. Do not claim the latter from a daily dump. |
| RTO (time to validated service recovery) | At most 1 hour, including alerting, authorized operator response, key retrieval, restore, validation and connection switch. Measure with representative data. |
| Cadence | Daily logical backup; alert if the most recent **successful, restorable** archive is over 24 hours old. Track start/snapshot/completion time, size, checksum, schema and key version without content. |
| Retention | Proposed 7 daily, 4 weekly, 3 monthly copies. Review privacy/erasure obligations and cost before adoption; document expiry and deletion verification. |
| Independent storage | Restricted storage in an approved region/account or failure domain separate from the primary DB; no GitHub notes/code storage or public CI artifacts. |
| Encryption | TLS in transit and authenticated encryption of archives before durable storage. Store recovery keys separately in a secret manager, with tested authorized recovery and rotation. Never persist plaintext private dumps in repo/temp/debug logs. |
| Access | Dedicated least-privilege backup reader; separate archive writer, restore operator and key access. Audit access without logging connection strings or content; protect against routine credential compromise deleting every copy. |
| Drills | Repeat after schema/extension changes and at least monthly; independently test decryption/key access, corruption rejection, retention expiry and restore on representative data. |

[PostgreSQL's pg_dump documentation](https://www.postgresql.org/docs/16/app-pgdump.html)
describes consistent single-database logical snapshots and custom-format archives.
Cluster-global roles and tablespaces require separate handling. The current drill
uses `--no-owner --no-acl`; it does not back up role credentials, production grants,
provider configuration or secrets. Reprovision those through a reviewed secret and
infrastructure runbook before serving restored data.

## Neon PITR verification — still pending for this project

Neon's [history-window documentation](https://github.com/neondatabase/website/blob/main/content/docs/postgres/backup-restore/history-window.md)
and [branch restore documentation](https://github.com/neondatabase/website/blob/main/content/docs/postgres/backup-restore/branch-restore.md)
describe recovery within a configured history window. Do not infer the project's
actual window, oldest recoverable point or recovery availability from a plan name
or documentation. In the authenticated provider console, record the active project,
branch, current history setting, earliest restorable timestamp, region, access and
cost constraints in a **private** operations record. Verify recovery to an isolated
target and test access without redirecting the active application. Treat any
in-place branch rollback or production connection switch as a separate authorized
operation. Provider PITR does not replace an independent encrypted logical backup.

## Authorized live restore procedure — not executed by the drill

1. Have the owner authorize the exact archive/recovery timestamp, isolated target,
   operator and any eventual production switch. Pause affected writers/job consumers
   for cutover; preserve the old database and note the incident timeline.
2. Verify archive integrity and encryption key access in a trusted recovery host.
   Reject untrusted SQL archives. Restore into a **new empty database**, with API,
   GitHub and provider/notification/embedding workers disabled and network access
   restricted. Never run a destructive `--clean` restore against the active DB.
3. Validate migration history and version compatibility before running new code.
   Compare counts, IDs, source originals, current revisions/hashes, ownership and
   FK integrity against trusted backup metadata. Re-establish reviewed DB grants
   and identity configuration; authenticate two owners and test read isolation.
4. Reconcile GitHub from the restored durable checkpoint. Test missing events,
   sources already moved after the backup, changed/deleted paths and duplicate
   delivery without overwriting newer text. Expired leases can be retried through
   normal worker acquisition; do not blindly reset all pending jobs or leases.
   Keep external effects disabled until their idempotency is verified.
5. Verify DB-only captures and derived provenance without requiring GitHub copies.
   Only after validation and explicit cutover authorization switch connections,
   resume bounded workers and monitor lag/errors. Retain the old target for the
   approved rollback window; rollback must account for any new writes.

## Portable owner export and remaining gates

An owner-requested portable export is a **separate, explicitly authorized** feature;
it is not automatic replication to GitHub. No exporter ships in this change.
Future authenticated exports must derive owner identity from verified credentials,
query in owner scope in a consistent transaction, and preserve stable IDs,
originals, source metadata/current revision, timestamps, schema version and
resolvable provenance. Deliver through protected expiring access with a documented
retention/deletion policy; an export is sensitive data, not an operational log.

`captures` currently lacks an owner column and can group several notes. An exporter
must not serialize a shared capture's original text or other-owner related IDs just
because one note belongs to the caller. Define ownership and validate shared/legacy
unowned captures before exposing export. A partial owner export cannot substitute
for the full database backup or restore another owner's/global operational state.

Parent #61 still gates production rollout on verified encrypted retention/PITR and
recovery access, representative restore timing, live GitHub reconciliation, and
owner-scoped export. Future schemas must extend the drill with durable ingest
cursors, DB-origin capture/jobs, revision history, evidence/ledger provenance and
embedding configuration/version links as those features land (#43–#47, #55/#56).
Do not claim recovery of tables or workflows that do not yet exist.
