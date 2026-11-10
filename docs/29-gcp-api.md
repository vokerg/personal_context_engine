# Independent GCP API — stage 1 runbook (#188)

## Observed activation — 2026-11-10

Merged #190's immutable main artifact was installed on the existing VM with an
independent restricted API role and systemd service, now enabled across reboots.
The API stays on loopback; the separately configured nginx ingress provides
trusted TLS over the existing IPv6 route. No paid IPv4/NAT/load balancer was added.

Finite server-side HTTPS acceptance passed: issuer/resource discovery, anonymous
MCP denial, wrong-Origin/Host denial, password/secure cookies/CSRF, S256 consent,
refresh rotation/replay denial, the official client's 14-tool catalog,
idempotent synthetic capture with direct original/receipt/job readback,
Note/search/Task retrieval and revocation. The synthetic Note was soft-removed,
its original retained, and the finite test client/session credentials removed
or revoked. Actual ChatGPT plugin connection acceptance is **not established**.

A 120-request health/readiness load at concurrency four completed in 5.02 seconds
with stable service PIDs/restart counters. The API was approximately 84 MiB after
the load and peaked around 155 MiB during password/functional checks. Nginx used
about 6–8 MiB. Both existing workers kept their original PIDs and zero restarts.
These are bounded measurements, not a guarantee for arbitrary concurrent load;
temporary memory pressure during archive transfer/extraction was observed.
The installed unit/proxy validation and certificate renewal dry-run passed.

A stable Cloudflare Workers Free gateway now reaches the GCP IPv6 origin from
IPv4. Live gateway acceptance with the official MCP SDK passed public discovery,
anonymous denial, secure-cookie/CSRF login, S256 consent, refresh rotation/replay
denial, all 14 tools, synthetic capture/replay with DB original/receipt/job
readback, synthetic retrieval and soft-removal, and test-session/grant revocation.
A separate private reserve package and web MCP connector were created. Actual
ChatGPT web OAuth discovery passed and the displayed callback matched the exact
registration. Owner completed consent; scoped database readback confirmed an active reserve
ChatGPT grant with the four intended scopes, a 15-minute access token and
no fixed refresh expiry. The owner’s ChatGPT test conversation showed a live
reserve search tool trace and successful search/full-note retrieval; existing connections are
preserved. Exact inventory and protected probe evidence belong in private
operations documentation, not this public mechanism repository.

**Decision (2026-11-09):** keep Render API, Vercel/iOS, both existing workers,
private GitHub capture, and current ChatGPT OAuth clients unchanged. Provision
a second PCE API process on the **existing** GCP VM as a separate, initially
loopback-only service. This is **not** a public MCP cutover, a new VM, or an
approval of paid IPv4 or cloud ingress.

## Code and isolation

- `deploy/gcp/package-api.sh`: Node 22 x86_64 archive with compiled
  `@pce/api`, `@pce/db`, `@pce/core`, `@pce/contracts`, production
  dependencies, Prisma engine and immutable source SHA. Explicit allowlist.
  CI workflow `gcp-api-package.yml` builds it **without deployment secrets**
  and never pushes to GCP. It is a separate artifact from `worker.tar.gz`.
- `api-bootstrap.sh`: privileged *manual* creation of `pce-api` runtime
  identity, `/opt/pce-api`, `/var/lib/pce-api` and a dedicated systemd unit.
  It neither starts API nor touches `/opt/pce`, worker services, IAM or
  networking. `/etc/pce/api.env` is root-owned mode 0600.
- `api-install.sh`: root-only install from an operator-transferred archive
  with SHA-256, revision, archive path/type/size and runtime import checks.
  Swaps only `/opt/pce-api/current`, verifies systemd + local `/ready`
  and restores the previous API release on failure. A first-install failure
  stops API. No unattended PR deployment or sudoers expansion is installed.
- `pce-api.service`: non-login `pce-api` account, loopback `API_HOST`
  via private env, private writable state, no capabilities, systemd sandbox,
  initial high/hard RAM limits 256/384 MiB, 128 MiB V8 heap, CPU quota 25%.
  **Limits are proposed ceilings, not proof of available spare VM capacity.**
  This deliberately does not alter the active worker's 192 MiB cap.

## Operator preflight (required before starting)

1. Read existing `docs/26-worker-deployment.md` and verify the current GCP
   inventory via approved IAP/OS Login path. Record sanitized aggregate RAM,
   CPU pressure, available disk, SportOS/PCE worker peak RSS/CPU, and systemd
   restart counters. Confirm there is headroom for **concurrent** workers,
   Fastify/Prisma, 128-MiB scrypt password derivation and OS. If capacity
   is insufficient, **do not start this API**; do not relax existing worker
   quotas to make it fit.
2. Review the current production DB schema, TLS connectivity, pooler and max
   sessions. Provision an **API-specific restricted DB role**, not the worker
   processing role or DB migration owner. The API requires owner-scoped
   Note/search/OAuth session and capture read/write privileges; review the
   actual SQL/schema grants rather than copying the worker's limited grants.
   Append a small Prisma `connection_limit` (e.g. 2) to the actual runtime
   URL. No migration runs on the VM.
3. As the operator, transfer the **reviewed** bootstrap/unit/install scripts
   via the existing pinned IAP SSH mechanism. Verify bytes/checksums. Run
   `sudo bash api-bootstrap.sh` from their common directory.
4. Privately fill `/etc/pce/api.env` with the existing trusted owner subject,
   an independent API DB login, existing single-user username/password hash,
   and confirmed origin settings. Restrict to 0600, root-owned. Do not store,
   print, echo, email, commit or publish any env values.
   Initially leave `PCE_MCP_ENABLED=false`,
   `PCE_GITHUB_FETCH_ENABLED=false` and provider/Task-suggestions gates off.
   `API_HOST=127.0.0.1`, `API_PORT=3112`. The web/API origins must use
   **one hostname** under PCE's present session contract. In this local-only
   phase they are configuration placeholders, not a publicly routed issuer.
5. Only after verified capacity, DB role, service unit, artifact provenance
   and private config, create root-owned `/etc/pce/api-ready`. This is an
   operator activation gate, not a public deployment flag.

## Package and install

Run the new packaging workflow on reviewed source, or locally on Linux x86_64
with Node 22, `npm ci` and `bash deploy/gcp/package-api.sh OUTPUT_DIR`.
The produced `api.tar.gz` and `api.tar.gz.sha256` contain no runtime
credentials. Transfer them to a root-controlled temporary location on the VM
through verified IAP/OS Login. Do not expose the VM's application port.

Use the **exact source commit SHA** printed by the build and the verified
SHA-256 of `api.tar.gz`. On the VM the operator runs:

```sh
sudo /usr/local/sbin/pce-api-install SOURCE_SHA /absolute/path/api.tar.gz SHA256
curl --fail --silent --show-error http://127.0.0.1:3112/health
curl --fail --silent --show-error http://127.0.0.1:3112/ready
sudo systemctl show pce-api.service --property=ActiveState,SubState,NRestarts,MainPID,MemoryCurrent,CPUUsageNSec
```

The installer verifies local `/ready`; the additional probes are independent
readback. Do not run it with missing `api-ready` marker, an unreviewed artifact,
an unsigned revision assumption, or private data on a public CI runner.

## Load and regression acceptance

Measure baseline, idle API, and bounded concurrent **synthetic**
`/health`/`/ready` requests; sample process RSS, systemd
`MemoryPeak`/`MemoryCurrent`/`CPUUsageNSec`, open DB connections and
application errors. Verify PCE and SportOS workers' active states and
`NRestarts` stay stable during and after the experiment. A readiness 200
without memory/DB/worker measurements is insufficient to accept the service.
No personal Note bodies, token values, DB URLs, journal messages or account
inventory may appear in public issues or logs.

Only **after** successful measured acceptance, enable persistence across VM reboots
with `sudo systemctl enable pce-api.service` (this does not restart the unit).

To pause the experiment: `sudo systemctl stop pce-api.service`. Leave
the existing workers and Render untouched. For an already installed API release,
the installer automatically restores the prior `current` symlink on failure.
For later operator-initiated rollback, stop API, verify the intended previous
release and revision, atomically repoint **only** `/opt/pce-api/current`,
restart and recheck `/ready`. Never remove DB originals or migration history.

## Stage 1b: public reachability and identity

PCE uses a canonical HTTPS `issuer` equal to its API origin, an OAuth
`resource` of `<issuer>/mcp`, and host-only browser-session cookies. The
browser origin must share its hostname. Adding a second public address,
changing a reverse proxy, or forwarding only `/mcp` can break OAuth consent,
CSRF, issuer/resource checks and refresh. Before exposing the GCP API, choose
and verify a TLS ingress reachable from ChatGPT **without assuming paid IPv4**;
test the exact Host and trusted transport origin, root and MCP discovery,
OAuth login/PKCE/refresh and `capture:write` on a separately consented test
client. Do not claim an IPv6-only listener is globally reachable.

Render/Vercel continue to serve real traffic until GCP's public endpoint,
OAuth and connector acceptance are independently observed. Do **not** copy
Render's session tokens or rebind the current live client by changing only a
URL. The single PCE plugin and clean NOTES 2 trial are tracked by #189,
with conditional MCP-native capture acceptance in #49 and #50.

## Reserve MCP ingress (#191)

The owner clarified that the reserve API must be usable by ChatGPT and retained
the no-paid-IPv4 constraint. The independent ingress templates are
`deploy/gcp/nginx-api.conf.example` and `nginx-api-proxy.conf`. They do not
change the existing Vercel routes or Render issuer. Actual inventory and secrets
belong in protected operator state, never these templates.

Use an independently verified public DNS hostname and certificate. On the
existing IPv6 VM, a narrowly targeted ingress rule may allow only TCP 80/443
from IPv6; keep port 3112 on loopback and preserve the IAP-only SSH rule. Public
IPv6 and a valid certificate do not prove IPv4-only browser or ChatGPT access.
If client reachability fails, use a separately verified free tunnel/proxy; do
not add paid IPv4, NAT or a load balancer. Never declare an ephemeral development
tunnel a durable reserve endpoint.

Operator sequence after the stage-1 preflight:

1. Install distribution `nginx` and `certbot` packages. Check for existing proxy
   services/configuration before installation; preserve unrelated applications.
2. Create root-owned mode-0755 `/var/lib/pce-api-acme` for HTTP-01 challenges.
   Do not put the challenge root inside private mode-0700 API state. Initially
   serve only ACME challenges; return 404 for other HTTP requests until TLS exists.
   For a newly dedicated nginx installation, install `nginx-api-limits.conf` as
   `/etc/systemd/system/nginx.service.d/pce-api-limits.conf`, then daemon-reload
   and apply the limits to nginx alone. Its proposed ceilings are 32/64 MiB and
   10% CPU; verify actual headroom. Never impose these on an unrelated shared proxy.
3. Obtain a publicly trusted certificate for the verified hostname, configure
   automated renewal and a successful-renewal nginx reload hook. Never bypass TLS
   validation. Verify expiry and independent client connectivity.
   Install `api-certificate-renewed.sh` root-owned mode 0755 under
   `/etc/letsencrypt/renewal-hooks/deploy/`; verify the Certbot timer and a renewal
   dry-run, then verify the reload hook independently without printing certificates.
4. Build the existing web login from the same reviewed source in an environment
   without private `.env` files. Enable the existing public browse/search/Task/
   research flags only when the reserve API enables them. Install static assets
   in a root-owned version directory under `/opt/pce-api/web` and atomically
   select `current`. The web API base is its own origin.
5. Replace `PCE_API_HOSTNAME` in the example with a validated DNS hostname,
   install the proxy snippet at `/etc/nginx/snippets/pce-api-proxy.conf`, run
   `nginx -t`, then reload only nginx. The example uses request/connection limits,
   a stricter password limit, no request/error logs, bounded bodies/timeouts,
   strict Host checks and unbuffered MCP forwarding. No forwarding header selects
   identity or bypasses the API's Host, Origin or CSRF checks.
6. Set `PCE_WEB_ORIGIN`, `PCE_API_ORIGIN` and `PCE_MCP_TRANSPORT_ORIGIN` to
   this new exact HTTPS origin. Register a separate `pce-gcp-chatgpt` client with
   the exact supported ChatGPT callback and only explicitly consented scopes.
   Existing clients, sessions and origins stay unchanged. Use a separate finite
   acceptance client; revoke its test grants and remove registration afterwards.
   Copy the exact callback shown by the actual ChatGPT creation form: newer
   plugin flows can allocate a per-connection callback, so do not assume the
   historical shared callback works for a new reserve connection.
7. Enable `PCE_MCP_ENABLED` and the already-deployed Task/research/diagnostics
   capabilities as appropriate, with matching explicit runtime DB grants. Keep
   provider calls, GitHub acquisition and mobile OAuth disabled in this reserve
   runtime unless separately activated. Lexical retrieval requires no provider key.
8. Test discovery, anonymous 401, wrong Host/Origin denial, password/CSRF,
   authorization-code S256, refresh rotation/replay denial, the official MCP
   client catalog, idempotent synthetic capture and direct DB persistence. Verify
   existing workers' PIDs/restart counters and aggregate load. Soft-remove only
   synthetic Notes and revoke only test grants; never log authenticated bodies.

The runtime DB login must not own schema objects, create objects, delete Notes
or update original bodies. Grant only the tables/columns used by enabled API
capabilities. Keep its Prisma pool at two connections and PostgreSQL role at
three sessions, with statement/lock/idle-transaction deadlines. An authenticated
functional test must exercise these privileges; `/ready` alone checks connectivity.

For rollback, stop the reserve API and its dedicated ingress, remove only the
new VM-targeted firewall rule/tag, and restore the previous API/static symlinks
and protected configuration. Preserve existing providers, workers and DB data.
Public DNS, TLS and actual ChatGPT installation/consent are independent gates.

### Free gateway — deployed 2026-11-10

`deploy/gcp/edge-proxy.mjs` is an optional stateless Cloudflare Worker to make
the existing IPv6 GCP origin reachable through a stable `workers.dev` hostname.
It hosts no API/domain processing or storage. All login, OAuth, capture and
retrieval still run on the GCP API against PostgreSQL. The owner authorized account creation and CLI access. Workers Free was verified
active with no payment method; no paid subscription, IPv4, NAT or load balancer
was added. Gateway deployment and live IPv4 acceptance are verified; actual
ChatGPT consent/tool invocation is a separate outstanding gate.

The Worker pins one operator-configured HTTPS `UPSTREAM_ORIGIN` and one exact
`PUBLIC_ORIGIN`; caller URLs and forwarding headers cannot select another
upstream. Bodies, cookies, Authorization, Origin, discovery and callback redirects
are streamed/preserved without following redirects, parsing private payloads,
request logging or caching. Cloudflare's `cacheTtl: 0` forces cache writes and
must not be used here: the gateway sets `cacheEverything: false` and negative
`cacheTtlByStatus` across 100–599 to disable caching. Live readiness returned
`DYNAMIC` and `Cache-Control: no-store`. Fixed failures contain no exception/request data.
The example Wrangler configuration fails closed with placeholder origins and
disables observability and preview URLs. No KV, D1, R2, Cron or paid binding is used.

Operator activation and recovery procedure:

1. Verify the account uses **Workers Free**. Do not upgrade, add payment details,
   create a paid resource or overwrite an existing Worker. The documented Free
   plan currently allows 100,000 requests/day with bounded CPU; exhaustion can
   make this reserve route unavailable rather than authorize a paid upgrade.
2. Use an unused Worker name and its stable account `workers.dev` subdomain.
   Copy `edge-proxy.wrangler.example.jsonc` into protected operator state, set
   `main` to the absolute reviewed module path and fill the two actual origins
   there. Keep real inventory and Cloudflare credentials outside Git/CI.
3. Bundle with the official Wrangler CLI's `deploy --dry-run` before deployment.
   Deploy manually using the authenticated operator account, with no new
   production credential in public Actions. Inspect the resulting configuration
   to confirm request observability and preview URLs remain disabled.
   Observed Wrangler 4.159.0 deployment failed at its new deployments endpoint
   with the narrowly authorized legacy `workers:write` scope. The documented
   multipart `PUT /accounts/{account}/workers/scripts/{name}` and script-subdomain
   API worked with that same scope; do not broaden permissions merely to use a
   different CLI endpoint. Upload metadata sets `observability.enabled=false`
   and `logpush=false`; enable only the stable subdomain with previews disabled.
   Revoke temporary Wrangler authorization after readback (completed for this
   deployment). Never copy tokens
   into an upload script, repository, issue or log.
4. Set only the reserve API's web/API issuer origins to the new public Worker
   origin. Keep `PCE_MCP_TRANSPORT_ORIGIN` at the trusted GCP TLS origin: the
   gateway fetches that hostname, which nginx validates and forwards to the API.
   Do not rewrite or trust caller forwarding headers as the issuer/owner.
5. Copy the **actual** ChatGPT form callback into the reserve client's exact
   registration; request explicit fresh consent. Repeat HTTPS discovery,
   Host/Origin/CSRF, PKCE, refresh/revocation and synthetic idempotent capture
   through the public gateway, then verify the DB and actual ChatGPT tool calls.
   Existing Render/Vercel/native/current ChatGPT clients retain their origins.
6. If activation fails, remove/disable only this Worker and restore the saved
   reserve API origins/configuration. Keep the GCP listener, DB originals and
   existing providers intact. Do not substitute an ephemeral development tunnel
   for durable acceptance or claim automatic fallback.

This is incoming ChatGPT/browser → gateway → GCP traffic. It does not provide
GCP → GitHub egress and does not enable worker GitHub acquisition. A restricted
outbound relay would require its own issue, authentication and acceptance.

Gateway tests use synthetic Request/Response objects and a fake origin fetch:

```sh
node --test deploy/gcp/edge-proxy.node-test.mjs
```

See [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[request/redirect behavior](https://developers.cloudflare.com/workers/runtime-apis/request/)
and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

References: [nginx request limits](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html),
[Certbot renewal](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates),
[OpenAI custom MCP connection](https://developers.openai.com/api/docs/guides/custom-mcp-server).
