# 26 — Native GCP worker and independent deployment scopes (#169)

**Two-stage transition (#173):** the optional read-only GitHub → PostgreSQL staging → shared DB-only processor is implemented. The legacy flows below remain available only outside that explicit transition. Follow [the staging migration and rollout guide](27-ingestion-staging.md) for current gates, privileges, compatibility and pending hosted checks.

## Mechanism and activation status

This adapts [Sportos's native worker deployment](https://github.com/vokerg/sportos/tree/main/deploy/gcp).
The API stays on Render, the frontend on Vercel, and the worker uses the existing
Debian 13 x86_64 VM under systemd. No new VM, public application port, Docker,
paid egress, backup automation or retrieval cutover is introduced.

Checked-in setup is not live activation. Keep `GCP_WORKER_DEPLOY_ENABLED=false`
until cloud identity, host bootstrap, runtime credentials, schema compatibility,
dependency reachability and the combined resource budget have been verified.
Record actual deployment runs and remaining limitations in issue #169; real
cloud inventory belongs outside this public repository.

The prepared initial DB-only scope and release checks are in the
[first-activation checklist](../deploy/gcp/first-activation.md).

## Two deployment lanes

| Changed files | Render API + GCP worker | Vercel frontend |
| --- | --- | --- |
| `apps/api/**`, `apps/worker/**`, `deploy/gcp/**`, `render.yaml`, migration launcher | Yes | No |
| `apps/web/**`, `vercel.json` | No | Yes |
| `packages/**`, lockfile/root package/build config, deployment scripts | Yes | Yes |
| `apps/mobile/**`, docs, local skills and listed repository metadata | No | No |
| Unknown inputs | Yes | Yes |

`scripts/deploy/change-scope.mjs` defines the scopes. `render.yaml` supplies the
matching ignored paths; Vercel's existing ignored-build command uses the same
classifier. A mobile source change skips both lanes; changing the shared root
lockfile conservatively redeploys both, even when prompted by a mobile dependency.

Render and Vercel retain Git-triggered main-only deployments, exactly as in the
reference setup. The GCP workflow accepts **actual merged PRs into main only**,
validates and packages their immutable merge SHA, then deploys if enabled. They
share change scopes, not an atomic transaction across providers. Keep schema,
API, worker and queued jobs compatible during mixed-version rollout. Render
retains its existing migration startup; the GCP deployment never runs migrations.
Protect main from direct pushes: a direct push can trigger Render/Vercel but does
not deploy the worker.

Verify the Render service has applied the Blueprint `buildFilter.ignoredPaths`
or copy those exact values into Settings → Build & Deploy → Build Filters.
Keep the root directory at the repository root. Source files alone do not prove
that an existing dashboard-managed service has adopted a Blueprint change.
See [Render build filters](https://render.com/docs/monorepo-support) and the
[Blueprint specification](https://render.com/docs/blueprint-spec).

Vercel must use `node scripts/vercel-ignore-build.mjs` as its Ignored Build Step
and expose system Git variables. The script keeps non-main refs disabled and
compares the last successful deployment SHA with the current SHA, including
deleted and renamed source paths. Initial deployments or missing history build
conservatively. See [Vercel ignored builds](https://vercel.com/kb/guide/how-do-i-use-the-ignored-build-step-field-on-vercel).

The worker guard rejects a release when newer backend inputs have reached main;
later frontend/mobile/docs changes do not invalidate a pending worker release.
The changed-file API includes previous rename paths and fails closed on errors;
at the API's 3,000-file limit it conservatively rebuilds the backend.

## Worker runtime and limits

`deploy/gcp/package.sh` builds contracts, core, DB and worker on Linux x86_64 with Node 22.
It installs the locked production worker dependency closure with scripts disabled,
copies built workspaces and generated Prisma Debian/OpenSSL 3 engine, and includes
the Node binary/license. It archives an explicit allowlist and rejects external
symlinks/private configuration. A relocated archive import and inert-process
SIGTERM smoke run require no DB, GitHub credentials or provider calls. The VM
does no npm install, compilation, migration or dependency download.

The initial service runs existing `WORKER_MODE=db-jobs-loop`: deterministic
DB preparation, plus independently gated Task/research ingress and approved-tag
publication. It requires a trusted existing `PCE_OWNER_SUBJECT` and runtime DB
login. A pass starts immediately on service start, then the worker cools down for
60 minutes **after** each pass finishes. Prisma connects only for each pass and
disconnects in a `finally` block, including on failure; no idle DB sessions
are intentionally held during the cooldown. SIGTERM stops future passes, lets
the current pass complete, and has a 120-second systemd shutdown allowance.

This deliberately trades DB-backed job preparation and staging-import latency
(up to about one hour plus pass duration) for compute-idle time on Neon Free.
Direct API/MCP note capture is still committed immediately and does not wait
for the worker. Neon Free suspends a compute after about 5 minutes without
activity; frequent requests from the API, other workers or clients may still
prevent suspension. This change does not alter the separately gated
`embeddings-loop`, which retains its existing cadence.

**Execution boundary (D-034 / #180):** development-server ingestion and checkout
reconciliation have been removed. Only the explicitly started existing worker
may run its optional GitHub acquisition step. The API acquires on manual sync
requests only; the hosted application requires no Mac runtime. GitHub
acquisition/publication requires reachable GitHub API and separately configured
scoped credentials, with runtime private-repository checks.
The inspected shared VM has IPv6 egress only and GitHub API access failed from
it on 2026-11-01; leave these features disabled until egress is resolved.

Embeddings remain a **separate opt-in process**, with existing model/owner/
privacy approval/cost gates. They are neither combined into the DB-jobs service
nor enabled by deployment. A dedicated embeddings unit/config/resource budget
and actual provider checks are a separate activation step; never change
`WORKER_MODE` on this service to silently replace DB/ingress jobs with embeddings.

User-triggered Note Task suggestions (#184) run only in the API on Render (or
the explicitly configured local API). `PCE_TASK_SUGGESTIONS_ENABLED`,
`PCE_TASK_SUGGESTIONS_MODEL` and `DEEPSEEK_API_KEY` are not worker settings;
do not provision them on this VM or add a suggestion background process. Existing
deterministic Task ingestion remains independent. See [hosted configuration](19-hosted-deployment.md#on-demand-task-suggestions-184--186).

The PCE unit uses a 96 MiB V8 heap, 160 MiB memory high watermark, 192 MiB hard
cap, no swap and 25% CPU quota. These are initial ceilings, not a measured sizing
guarantee. Inspect total host memory and competing peak demand before starting;
monitor bounded workloads afterwards. Do not alter Sportos's service, journal
retention, networking or limits to make PCE fit without an explicit decision.
Originals/jobs remain in PostgreSQL, not the VM; no content checkout is packaged.

## One-time access and bootstrap

Reuse the existing network, IAP SSH path, verified host key and host prerequisites.
Create a **PCE-specific** deploy service account and repository-restricted WIF
provider; do not broaden the Sportos provider. Bind only this numeric repository
ID and owner ID, `refs/heads/main`, environment `gcp-worker-production`, and:

- `pull_request_target` for `gcp-worker-deploy.yml` at main;
- `workflow_dispatch` for `gcp-worker-control.yml` at main.

Read the repository's OIDC subject configuration before constructing its exact
`sub` condition: `gh api repos/OWNER/REPO/actions/oidc/customization/sub`.
Use the returned `sub_claim_prefix` plus `:environment:gcp-worker-production`.
PCE uses immutable subjects with owner/repository IDs, while the Sportos
reference retained a legacy name-only prefix. Do not disable immutable subjects
or loosen the remaining restrictions to fix an authentication failure. See
[GitHub OIDC subject formats](https://docs.github.com/en/actions/reference/security/oidc).

Grant VM-scoped non-admin OS Login, instance-scoped SSH-only IAP tunnel access,
the existing project-lookup role containing only `compute.projects.get`, and
Service Account User only on the inspected VM-attached account if required.
Never create a service-account JSON key or give CI project-wide admin/sudo.
Preserve unrelated IAM bindings and policy etags. Official guidance:
[Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation).

Create a GitHub environment `gcp-worker-production`, selected branch `main`
only (no tags), and store these as environment **Secrets** so public logs mask
inventory values:

```text
GCP_PROJECT_ID
GCP_VM_NAME
GCP_VM_ZONE
GCP_DEPLOY_SERVICE_ACCOUNT
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SSH_KNOWN_HOSTS
```

Pin `compute.VM_NUMERIC_ID ssh-ed25519 VERIFIED_PUBLIC_KEY` obtained from the
actual host public-key file through authenticated operator access. Never scrape
arbitrary serial-log SSH keys or bypass strict host checking.

After reviewing the application scripts, transfer `deploy/gcp` through pinned
operator IAP SSH, verify checksums, then run as the operator:

```sh
sudo bash /path/to/reviewed/deploy/gcp/bootstrap.sh PCE_CI_OS_LOGIN_USERNAME
```

Bootstrap creates `pce-worker` (non-login runtime), `pce-deploy`, `/opt/pce`
release/incoming paths, `/var/lib/pce` and `/etc/pce/worker.env` (root 0600).
It installs fixed root-owned helpers and five exact sudo lifecycle commands,
enables but does not start the service, and preserves existing runtime config.
It does not restart journald or any other worker. Reconnect CI to pick up group
membership, verify sudoers, unit syntax, runtime-user permissions and isolation.

Privately provision a runtime-only DB login and existing owner in the env file.
Do not reuse migration-owner credentials just because they are present locally.
Validate connection/TLS, existing migrations and DB rights privately. Enable
individual GitHub features only with the appropriate read/write token and
approved reachable destination; never put runtime secrets in GitHub Actions.
Create root-owned `/etc/pce/worker-ready` only after these checks. Enable the
repository gate, then merge an explicitly human-authorized backend PR for first
activation. If setup follows the implementation merge, use a small reviewed
backend follow-up PR; rerunning an obsolete merge is not a release strategy.

## Deployment, controls and recovery

Both workflows share `pce-gcp-worker-production` concurrency; a VM `flock`
serializes operations. CI verifies the SHA256 archive, transfers via pinned IAP
SSH and invokes the unprivileged fixed deploy helper. The helper bounds archive
size/expansion, rejects traversal/special files/escaping links, verifies revision
and imports, marks a complete release, atomically switches `current`, restarts
and checks stable PID/restart count for 20 seconds. This is process health;
privately verify actual DB progress and intended jobs separately.

Failed activation restores/restarts the prior release and reports failure. First
activation failure stops PCE and removes `current`. Retain current, previous and
one other release; configuration and DB records are never pruned. Deployment
and rollback refuse an absent readiness marker. Check free disk before each
deployment (1.5 GiB minimum). The source artifact is limited to 200 MiB compressed
and 750 MiB expanded, with no more than 100,000 members.

The main-only **GCP worker start stop restart or status** workflow offers these
four operations without deploying code or affecting the VM/Sportos. Public
workflow output contains systemd lifecycle metadata only, never application
journal output; inspect application errors privately. Root helper updates require
another reviewed operator bootstrap; a code deploy does not replace root helpers.

To roll back, use a pinned operator connection as the PCE deploy login:

```sh
/usr/local/bin/pce-worker-deploy rollback SHA-RUN-ATTEMPT
```

Only an existing complete release is eligible. Set the repository deployment
gate false to stop new automatic releases; stop the service to pause processing.
Keep originals/jobs and additive migrations. Database/schema rollback is not
performed by a filesystem rollback. Existing manual backup guidance remains
optional; automation #61 is deferred.

## Verification

```sh
node --test deploy/gcp/*.node-test.mjs scripts/deploy/*.node-test.mjs
shellcheck deploy/gcp/*.sh
actionlint .github/workflows/gcp-worker-deploy.yml .github/workflows/gcp-worker-control.yml
npm run docs:check
# Linux x86_64 / Node 22 with dependencies already installed:
bash deploy/gcp/package.sh /tmp/pce-worker-artifact
```

Linux CI exercises extraction, checksum rejection, failed activation/recovery,
rollback, interrupted releases and cleanup with synthetic fixtures. Mac/Windows
skip Linux-only host tests explicitly. Existing workspace and disposable DB CI
remain required; reusable release checks check out the exact merged revision and
receive no production/runtime secrets.

After the worker update is explicitly approved and deployed, verify the
GCP worker remains healthy, then check Neon at least five minutes after the
first completed DB-job pass: `pce_worker_runtime` should have no idle client
sessions, and the single production compute should become Idle if no other
clients are querying. Observe at least one subsequent hourly pass, compare
the CU-hour consumption slope and verify existing durable jobs progress.
Keep Neon credentials, note contents and live worker logs out of public CI.

After rollout, observe separate mobile-only, frontend-only, backend-only and
shared-input merges against actual provider histories. Filter unit tests alone
do not establish that dashboard settings or production deployment are correct.
