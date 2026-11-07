# 27 — Two-stage read-only GitHub ingestion (#173)

Implemented behind explicit acquisition configuration. Production migration,
role grants, deployment, hosted GitHub connectivity and cross-machine acceptance
are **not performed by this change**. Existing API/MCP capture remains direct
to canonical PostgreSQL originals and jobs. No retrieval cutover is implied.

## Data flow and shared implementation

Before: GitHub inbox → canonical note → GitHub file move → finalized status.
Task/research readers previously imported directly without moving files.

After: a GitHub-capable Mac worker or authenticated API → **the same**
`acquireGitHubArtifacts` → `ingestion_staging` → **the same**
`processStagingPass` on any worker → existing canonical importers → DB jobs.
The shared server implementations live in `packages/db/src`; the worker's
original GitHub adapter import path re-exports the shared adapter for compatibility.
Core contracts/domain validation remain unchanged. No new infrastructure,
GitHub Actions in private repositories, provider synthesis or outbound exporter
is introduced. A checkout is unnecessary for the new path.

The adapter verifies private visibility, uses the existing bounded HTTP retries,
rejects truncated/oversized trees, pins blob reads to the discovered revision,
and admits only regular `inbox/*.md`, canonical `notes/YYYY/MM/<id>.md`,
`tasks/inbox/<id>.json`, and `research/inbox/<id>.json`. Acquisition uses GET only;
it never calls finalization/rejection/move. Existing finalization methods remain
available exclusively to the legacy opt-in path and filesystem tests.

## Storage, identity and recovery

The additive `20261101193000_ingestion_staging` migration creates one table.
Each immutable original stores authenticated/trusted owner, provider, artifact
type, lower-case repository, case-sensitive branch, original path, Git blob SHA,
exact `bytea` bytes, SHA-256 and fetch time. UTF-8 BOM, CRLF, trailing whitespace
and invalid UTF-8 are retained; decoding/contract validation happens in stage B.
Invalid UTF-8 becomes an inspectable INVALID original. The provider's preexisting
1 MiB acquisition limit remains; task/research importers retain their stricter
65,536/250,000-byte domain limits. Unsafe objects and oversized/unreadable sources
are counted as fetch failures, left in GitHub, and retried in later sweeps.

A unique owner/provider/repository/branch/path/blob identity deduplicates both
entry points, including concurrent scans. Changed blobs create separate staging
records. Existing canonical ID, ownership, provenance and revision checks apply;
no expected-previous-revision override is supplied. Changed notes and conflicting
task batches become INVALID rather than replacing canonical data. Research
relationship/revision conflicts retain RETRY because the existing importer also
uses that classification for missing parent/citation/predecessor dependencies.
Semantically identical task/research JSON may replay the established canonical
receipt without changing canonical provenance. Raw bytes remain in staging.

Claims use one atomic PostgreSQL `FOR UPDATE SKIP LOCKED` update, scoped to the
trusted owner, with a five-minute lease and incremented attempt count. Each
bounded pass processes at most 16 records (hard maximum 100). Completion and
failure writes check worker, attempt number and live lease, preventing stale
workers from acknowledging reclaimed work. RETRY uses five-second to one-hour
capped exponential delays; invalid input is retained with a fixed error code.
There is no automatic deletion or maximum-age discard.

Existing importers own their serializable canonical transactions. Their durable
ID/hash receipts make replay safe if a process dies after canonical commit.
A subsequent transaction creates the existing note preparation job and records
PROCESSED together; failure rolls back **both**. Until that transaction succeeds,
the staging original is reclaimable and never reported processed. A research
import ensures its parent job exists; existing gated research candidate scans
prepare reports even if that parent's note job was previously prepared. Tasks
retain their current standalone persistence/event behavior; no Task embeddings
or external actions are invented. Independent embedding workers retain their
existing egress/privacy/model/budget gates.

A canonical note may briefly exist before staging acknowledgement/job creation.
An expired/retried claim repairs that gap. Logs contain counts and fixed error
classes only. Source disappearance never deletes canonical data or staging.

## Bounded discovery and manual API

Both entry points share a persistent `ingestion_checkpoints` scope hash with a
`github-staging-v1` namespace distinct from all legacy cursors. One scan examines
at most ten source references and has a 15-second acquisition budget. Individual
HTTP retries also remain bounded; final timeout/retry cleanup can extend beyond
that budget. Clients allow 25 seconds. A full recursive tree is still fetched,
with the existing 100,000-entry/truncation rejection; this is intended for the
existing personal repository, not arbitrarily large trees.

Cursor advancement happens after each original is durably staged. Read failures
are counted and passed over so one unsafe file cannot starve later input; a
completed sweep wraps to discover repairs, revisions and earlier insertions.
A crash/DB failure replays the old page safely. Checkpoint version CAS prevents
concurrent scans from overwriting newer cursor progress. A complete successful
sweep sets `lastSuccessfulScan`; partial batches and sweeps with fetch failures
do not claim success. This is source-state reconciliation, not Git history import.

With configured sessions and DB, routes are available even when fetching is off:

| Route | Authorization | Result |
| --- | --- | --- |
| `GET /api/v1/github-sync/status` | `notes:read`, configured owner | Fetch availability/reason, last successful full scan, continuation and pending/processed/invalid staging counts |
| `POST /api/v1/github-sync` | `capture:write`, configured owner; browser Origin/CSRF | Examined, newly staged, already staged, failed and whether another batch remains |

POST accepts an empty object or no body, at most 1 KiB. No client owner,
repository, credential, cursor or batch-size parameters are accepted. Browser
sessions use existing Origin/CSRF; native OAuth uses its existing capture scope.
OAuth consent explains that capture access can request configured-source sync.
A server-side configured credential is the only GitHub credential. Disabled or
unavailable fetching returns sanitized 503; overlapping/rapid requests return
429/Retry-After. Each API instance admits one acquisition at a time with a
five-second cooldown. Multiple instances still deduplicate through PostgreSQL;
this is not a distributed GitHub rate-limit quota.

Web has one compact header control; iOS has one Settings control using the same
client functions. Loading prevents resubmission. Completion explicitly says
**staged**, with separate processing backlog/inspection state. Each click runs
one finite batch; click again when continuation is reported. Status refreshes
while mounted every 30 seconds; fetching is never automatically triggered by
opening a screen. Errors contain no server exception/private source text.

## Execution ownership (D-034; #180)

One DB-jobs worker implementation runs on either host. When explicitly started
on a GitHub-capable host with fetching enabled, each pass acquires first and then
consumes staging and prepares jobs. GCP disables acquisition and uses the same
consumer without GitHub credentials. A development web/API server never starts
an importer, worker or GitHub timer. The API's fetch gate permits only explicit
manual sync requests; status reads and opening clients never acquire content.

The hosted app needs no Mac runtime: **web/iOS Sync from GitHub → hosted API →
PostgreSQL staging → GCP worker → API reads**. Each button press performs one
finite batch; repeat when continuation is reported. Client status polling only
reads counts. Embeddings remain separately opt-in; stopping local embedding
scheduling pauses fresh semantic vectors without blocking lexical retrieval,
original persistence or ordinary DB preparation. No replacement embedding
service is implicitly enabled by this execution-boundary change.

## Production rollout — manual, ordered and reversible

1. Stop/disable legacy note finalization first for this source:
   `PCE_INGEST_GITHUB=false`; stop scheduled `WORKER_MODE=once` GitHub writers.
   Wait for in-flight finalization to finish. Stop independent direct Task and
   research readers during transition. Do not run old and new acquisition for
   the same repository. New acquisition rejects legacy note-write opt-ins in
   the same process. Old deployed binaries cannot be fenced by a new flag;
   stopping them is an operator prerequisite.
2. Using the existing migration identity/direct TLS connection and normal
   migration procedure, apply the additive migration with `npm run db:migrate`.
   Never reset a database or run tests against production. API and workers must
   receive the migration before code that queries staging. Retain old tables,
   cursors, attempts, tags, chunks and embeddings. Existing API captures do not
   need any migration through staging.
3. Inspect the existing runtime role. As the administrator, manually apply
   [staging-grants.sql](../deploy/gcp/staging-grants.sql) with
   `psql <private-runtime-admin-connection> -v worker_role=pce-worker -f deploy/gcp/staging-grants.sql`.
   The consumer adds canonical SELECT/INSERT, staging SELECT and **only status,
   lease, retry and result-column UPDATE**, plus preparation-job INSERT. It gets
   no staging original UPDATE/INSERT/DELETE, GitHub token, auth reads, canonical
   text UPDATE, schema ownership or administrative role. Existing preparation
   privileges, including note ID-only row-lock permission, remain necessary.
   Mac/API acquisition roles additionally need staging SELECT/INSERT and
   ingestion-checkpoint SELECT/INSERT/UPDATE. Provider execution and research
   chunk preparation still require their separate reviewed privileges/gates.
4. Verify existing ownership before replay. Same-owner exact-hash/blob canonical
   notes from historical finalized paths replay while retaining their original
   source path, lifecycle, overrides and embeddings. Unowned/foreign notes are
   **not adopted**. Historical checkout-normalized hashes, unsupported renames,
   differing revisions or owner discrepancies need explicit operator repair;
   they become inspectable conflicts. A new canonical-folder original maps to
   the existing validated inbox locator for the importer; staging retains its
   actual canonical GitHub path.
5. Inspect legacy `processing_attempts` PENDING/LEASED/RETRY/PERSISTED/REJECTED
   and research/task ingress attempts before transition. Let live legacy leases
   finish before stopping. New scans independently recover unchanged current
   sources; already committed notes/batches/reports replay. Retain legacy
   attempts as historical evidence: the new worker never resumes their GitHub
   moves. Inputs missing from GitHub but present only as a legacy retry must be
   repaired/recovered explicitly; no original bytes are fabricated. Do not mark
   those attempts finalized merely to hide them.
6. Deploy reviewed code through existing independent release mechanisms after
   authorization. Configure the Mac:

   ```dotenv
   WORKER_MODE=db-jobs-loop
   PCE_OWNER_SUBJECT=<existing-persisted-owner>
   PCE_GITHUB_FETCH_ENABLED=true
   PCE_INGEST_GITHUB=false
   CONTENT_REPOSITORY=owner/private-content
   CONTENT_BRANCH=main
   CONTENT_GITHUB_TOKEN=<server-only-repository-scoped-Contents-read-token>
   PCE_TASK_INGRESS_ENABLED=false
   PCE_RESEARCH_INGRESS_ENABLED=false
   ```

   Use existing TLS `DATABASE_URL`, build and run `npm run db-jobs:watch` with the
   trusted environment. Development servers never acquire or process content,
   even with this gate enabled. `dev:local` uses the shared owner-scoped API DB
   reader; no content checkout or startup import is required.
   The standalone worker default remains idle without explicit WORKER_MODE.
7. Configure GCP `WORKER_MODE=db-jobs-loop`, the same trusted owner, existing
   restricted TLS URL/connection limit, and `PCE_GITHUB_FETCH_ENABLED=false`.
   Keep GitHub ingress gates false and **do not supply CONTENT_GITHUB_TOKEN**.
   The same processor consumes pending originals before ordinary DB preparation.
   Acquisition errors on a fetching host cannot block that host's staged work.
   OpenAI is neither initialized nor called by this DB-jobs mode. Enabling the
   existing separate embedding process is a distinct operator step.
8. Keep hosted API fetching false until the actual Render runtime passes
   `node scripts/check-github-fetch.mjs` with privately supplied CONTENT_*.
   It checks private repository visibility/branch/tree over HTTPS and writes
   neither GitHub nor PostgreSQL. A local Mac check does **not** prove Render
   egress. Hosted access could not be verified in this implementation session;
   the public Blueprint stays false and the button explains unavailability.
   After successful preflight and operator authorization, enable the same gate
   and server-only repository-scoped Contents:read token on Render. Never put
   the token in Vercel, EXPO_PUBLIC_*, VITE_* or mobile storage.
9. Verify with authorized synthetic input: Mac stages; GCP imports without a
   GitHub token; ordinary preparation and separately enabled embeddings work;
   source tree stays unchanged; repeated Mac and manual web/iOS sync deduplicate;
   restart with pending/leased work recovers. Observe count-only DB evidence,
   runtime CPU/memory/connections and unchanged Sportos health. These actual
   cross-host, provider and device acceptance checks remain manual/pending.

Approved-tag publication remains independently gated by
`PCE_TAG_SNAPSHOT_ENABLED` and its own verified write credential. A Contents:read
fetch token cannot publish tags; retain a distinct write credential if that
separately authorized feature is needed. Setting fetch false does not disable
that exporter, so leave its own gate false on the IPv6-only GCP host.
No outbound GitHub synchronization mechanism is added.

Rollback: stop new acquisition/processing, retain staging/canonical data and
migration, and roll back to a compatible release. Keep legacy finalization off
unless the owner deliberately opts back into GitHub mutations. Do not drop
staging or reset canonical IDs/receipts to replay. For inspected INVALID records,
an administrator may reset **only** status/lease/retry/error/result fields to
PENDING while retaining immutable bytes and provenance. Retry repaired source
as a new blob instead of editing old staged bytes. Missing dependencies retry
automatically; original-changing revisions require explicit conflict resolution.

## Validation and remaining acceptance

Synthetic PostgreSQL tests exercise the real GitHub adapter with fake immutable
Git objects and reject every non-GET request. They cover exact bytes including
invalid UTF-8, duplicate/concurrent scans, API/Mac identity, owner-scoped claims,
notes/tasks/research, missing parents, changed revisions, legacy finalized replay,
missing sources, expired/crashed workers, fenced acknowledgements, job-write
rollback/retry and minimum-role imports/preparation. Authenticated API tests cover
CSRF, owner restriction, disabled state, repeated acquisition and throttling.
Shared transport and web/iOS rendering tests cover request/status/loading/counts.
Existing API/MCP capture, chunk/embedding, legacy worker and deployment suites
remain regression checks, not proof of production rollout.

No private content/credentials are used in these tests. Use a disposable local
PostgreSQL/pgvector database through `PCE_DB_TEST_URL`, with an isolated checkout
without private dotenv files; existing #78 configured-checkout contamination is
not solved here. Actual migration/grant application, Render preflight, cross-host
end-to-end processing, GCP resource pressure and physical iOS operation remain
explicit pending checks. No production deployment or Sportos/network change is
authorized by test success.


Verified locally under Node 22 in an isolated checkout: all 495 tests in 100 files
passed against disposable UTF-8 PostgreSQL/pgvector with serial file execution;
workspace build/typecheck/lint/format and documentation checks passed, migrations
applied/replayed with no schema drift, and the iOS JavaScript export passed.
Deployment mechanism tests passed 23, with 10 Linux-only cases skipped on macOS;
the actual portable Linux artifact remains a CI check. An initial broad run using
SQL_ASCII and parallel DB suites failed; corrected UTF-8/serial execution passed.
These results do not establish any production or physical-device acceptance.
