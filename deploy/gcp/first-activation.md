# First DB-processing worker activation (#171)

The implementation PR #170 is merged. Its merged-PR validation/package workflow
passed with deployment disabled. The separate worker identity, pinned IAP/OS
Login transport, host bootstrap and restricted runtime environment have been
prepared; the manual GitHub **stop** operation passed end to end. The service is
enabled but inactive; no readiness marker or current release exists yet.

A finite, read-only process from the actual merged Linux artifact connected to
the hosted DB as `pce-worker`, under the intended memory/CPU/sandbox settings.
It verified the restricted login and expected relation/row-lock access, without
claiming jobs, reading note text into logs, or making provider requests. This
establishes runtime connectivity, not completed background-job processing.

## Concrete activation scope

- Start existing `WORKER_MODE=db-jobs-loop` with the existing persisted owner.
- Limit Prisma to two connections (`connection_limit=2`) and the login to three;
  retain the checked-in 192 MiB hard cap, 96 MiB heap and 25% CPU quota.
- Enable deterministic DB preparation only. Leave Task/research GitHub ingress,
  tag publication, research backfill and OpenAI embeddings disabled. No provider
  or private GitHub token is included in this runtime environment.
- Keep the current API, local capture/reconciliation, ChatGPT retrieval path and
  existing local workers available. This release does not activate notifications,
  execute Task text, change API/connector scopes or authorize paid egress.

The dedicated login has no elevated role memberships, superuser, RLS bypass,
role/database/schema creation, session/grant reads or original-text update rights.
Its grants cover DB-job SELECT/UPDATE, chunk SELECT/INSERT/DELETE, embedding-job
SELECT/INSERT and note SELECT. PostgreSQL row locking requires UPDATE privilege
on at least one note column; only the ID column has that grant, not body,
original text, ownership or lifecycle fields. Runtime code never updates that ID.
These grants serve this selected queue scope; they do not enable ingress or paid
embedding execution. Credentials remain root-owned 0600 outside Git/releases/CI.

Use explicit runtime connection configuration during private preflight. Prisma
can load a source checkout's `.env`; merely calling `process.loadEnvFile` later
does not override existing variables. A test under the deployment's systemd
EnvironmentFile and packaged code is required to verify the actual runtime login.

## First release procedure

1. Confirm current main includes #170 and this release PR. Recheck immutable OIDC
   subject prefix and all main/environment/workflow restrictions, pinned host,
   exact CI sudo commands, root configuration permissions and feature gates.
2. Confirm runtime DB/TLS/schema/grants and current combined host pressure. Idle
   connectivity measurements are not a simultaneous worst-case workload proof;
   monitor a bounded first batch and keep existing services observable.
3. After explicit owner authorization of this release PR and the scope above,
   create `/etc/pce/worker-ready`, set `GCP_WORKER_DEPLOY_ENABLED=true`, then merge
   the release PR. Its backend deployment inputs trigger the existing pipeline.
4. Verify the exact merged revision in `current/REVISION`, non-root systemd
   process, stable PID/zero restart growth and expected disabled feature gates.
   Run the main-only manual **status** workflow as a separate control check.
5. Privately verify useful DB preparation: record aggregate before/after queue
   state and lease/completion evidence, or a bounded synthetic API capture with
   resolvable private provenance. Process uptime alone is insufficient. Do not
   print note IDs, bodies, credentials or raw application journals publicly.
6. Check actual memory/connection footprint and Sportos remains active with no
   unexpected restarts. Record source revision, run URLs, job evidence and limits
   in issue #171 and the private operations inventory.

First-release failure stops PCE and removes its current pointer; there is no prior
release to recover. Disable the release gate and use **stop** to pause processing.
Do not erase configuration, DB originals, chunks/jobs or migration history to
simulate rollback. Later compatible complete releases support normal rollback.

## Independent remaining acceptance

The VM still cannot reach the GitHub API over IPv6. Keep hosted GitHub features
disabled until an approved reachable route and scoped credentials are verified.
No external IPv4/NAT or other paid resource is part of this release. Separate
OpenAI worker activation also retains its independent gates and resource budget.

The source deployment scopes are implemented, but the live Render build-filter
settings and Vercel ignored-build configuration still require provider readback
and per-scope merge evidence under #169. The browser's input operations timed out;
source configuration or provider deploy success does not prove those live filters.
