# 21 — Approved-tag snapshot bridge (#100)

**Status:** feature-branch implementation only; **disabled by default**. No live
publication, GitHub credential provisioning or ChatGPT Project prompt changes
are implied by merging code. This is the deliberately temporary D-024
compatibility projection, not a replacement for PostgreSQL or MCP.

## Contract and trust

Only the owner-scoped **approved** vocabulary from PostgreSQL may be exported.
The worker never reads or publishes raw notes, source Markdown, candidates,
embeddings, captures or research. Approved slugs can still reveal private
topics, so `taxonomy/approved-tags.json` belongs **only in the private**
`vokerg/personal_context_engine_content` repository.

The UTF-8 JSON contract is deterministic and ends in one newline:

```json
{
  "schema_version": 1,
  "revision": 0,
  "tags": []
}
```

A nonempty `tags` array contains at most 200 slug-sorted objects with
`slug`, `display_name` (string/null) and `description` (string/null),
in that property order. Valid slugs are lowercase Markdown-v1 slugs of at
most 64 characters; display names ≤120 and descriptions ≤500 Unicode
characters. Revision is a monotonically increasing owner-scoped integer
from the authoritative registry. The SHA-256 checksum of the exact
serialized bytes is recorded in the DB; the snapshot omits the owner's
internal identifier and any published timestamp, so unchanged content
does not generate commits. More than 200 approvals fail **closed** as
`REGISTRY_TOO_LARGE` (no silently truncated publication).

## Internal delivery

1. Approved-tag mutation and coalesced `tag_snapshot_outbox` row advance
   in **one serializable transaction**. No-op approvals do not enqueue.
   The migration seeds pending intents for existing owner revisions.
2. An explicitly opted-in pass of the **existing DB worker** leases one
   owner job, reads one repeatable-read snapshot and checks the GitHub
   repository's actual `private: true` metadata before touching content.
3. Only `taxonomy/approved-tags.json` is read/updated with the GitHub
   Contents API. If the existing payload matches byte-for-byte, no commit
   is made. A changed payload is uploaded with the previous blob SHA
   (compare-and-swap) and **read back** before DB publication status
   advances. Newer or malformed remote snapshots are never overwritten.
4. Errors are stored as bounded non-sensitive codes; leases can expire,
   retries use exponential backoff with six-attempt cap. If the registry
   changed during an in-flight upload, an older revision cannot be
   acknowledged against the latest outbox row: the new job remains pending.
   An interrupted write can safely replay through GitHub read-back/no-op.
5. `GET /api/v1/tag-registry` (authenticated `notes:read`) exposes
   `snapshot.desiredRevision`, `publishedRevision`, `publishedAt`,
   `stale`, state and sanitized `lastErrorCode` for owner-only UI.
   `publishedRevision: null` means no verified publication. The API
   cannot assume that an optional worker is running.

This outbox deliberately does **not** abuse the note-bound
`db_processing_jobs` table, run embedding APIs, sync notes or block
approval, note capture, indexing or search when GitHub is unreachable.

## Explicit operator rollout (never automatic)

1. Review this public PR and the companion private content-repo PR.
   Apply the Prisma migration and run synthetic DB/publisher checks on
   a disposable Postgres database. Do **not** add synthetic or real
   taxonomy JSON in the public repository.
2. Verify the exact destination repository is **Private** using the
   GitHub API. Provision a **separate worker-only** short-lived fine-grained
   token / GitHub App installation limited to the private content repo
   with repository *Contents: read/write* permission. GitHub's ordinary
   repository permission is broader than one path; enforce the fixed
   path in this publisher's code and isolate the token from all capture
   agents, browsers and public CI. Do not confuse this token with
   `CONTENT_GITHUB_TOKEN` used for optional ingestion.
3. Configure trusted server-only environment values:
   `DATABASE_URL`, `PCE_OWNER_SUBJECT`,
   `PCE_TAG_SNAPSHOT_ENABLED=true`,
   `PCE_TAG_SNAPSHOT_ALLOW_WRITES=I_VERIFIED_PRIVATE_REPOSITORY`,
   `PCE_TAG_SNAPSHOT_REPOSITORY=owner/verified-private-repo`,
   `PCE_TAG_SNAPSHOT_BRANCH=main` and `PCE_TAG_SNAPSHOT_TOKEN`.
4. With a reviewed deployment and owner authorization, run a finite
   `WORKER_MODE=db-jobs-once` pass or supervise the **same existing
   worker runtime** in `WORKER_MODE=db-jobs-loop` (~60 second cooldown
   after each pass). `npm run db-jobs:watch` loads the ignored root
   `.env`; this is not an always-on schedule by itself. The pass also
   runs normal DB preparation work, with no embedding-provider egress.
   If a production scheduler already launches these DB passes, use
   that infrastructure; do not assume hosted job execution is configured.
5. Confirm `publishedRevision = desiredRevision`, `stale: false`
   in the authenticated API and read the exact version/hash of the
   private JSON file. Publishing is **not immediate** when the worker
   is offline. In #105 only, install the combined live `NOTES` Project
   prompt and test fresh text/voice capture with safe synthetic notes.
   The prompt must **explicitly read** the private snapshot: repository
   files are not automatically loaded by ChatGPT.

## Opt-out, conflict and recovery

Set `PCE_TAG_SNAPSHOT_ENABLED=false` or stop the separately opted-in
DB worker mode. Existing JSON and private notes remain unchanged; the
DB vocabulary continues to work. If the exporter is off, the last
published snapshot may be **stale** after owner mutations. Until the
owner verifies freshness, capture may use no tags or conservative
candidates; it must not claim an unavailable tag registry was read.

Malformed remote JSON, an unexpected newer revision or a CAS conflict
must be reviewed, not resolved by force-push. Permission errors require
token repair. Jobs marked `FAILED` after six attempts require an
explicit operator review/requeue or another owner registry mutation
to create fresh intent. Re-enabling the flag alone does not certify
a previously failed job as published. Monitoring and logs contain only
counts and error codes, not slugs, identifiers or note bodies.

The capture agent **remains create-only** for `inbox/` and cannot
update `taxonomy/`. The companion private repo PR updates
`AGENTS.md`/`README.md` for optional snapshot reads, not the installed
ChatGPT Project instructions. #105 owns prompt consolidation and actual
Project-mode acceptance. Once MCP-native capture has suitable authenticated
tag lookup, remove this exporter independently; never make it a core
PostgreSQL dependency.
