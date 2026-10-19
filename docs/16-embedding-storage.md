# 16 — Embedding storage and deterministic chunking (#46)

**Status:** Additive PostgreSQL schema and a manually invoked preparation API; no embedding provider, automatic indexing, vector search or ChatGPT search switch. Issue #47 owns asynchronous provider execution and backfill orchestration. Issue #44 still owns production identity/token issuance.

## Deployment prerequisite

The checked-in migration `20261018211500_pgvector_chunks` requires a PostgreSQL 16 instance with `pgvector` installed and the `vector` extension creatable by the migrator (or provisioned first by the DBA). It fails closed when unavailable; this is not a fallback to plain PostgreSQL.

Before deploying the migration, on the **target** host under operator control:

1. Verify `SELECT name, installed_version FROM pg_available_extensions WHERE name = 'vector';` reports availability; if missing, install pgvector using the actual hosting provider's documented method or defer rollout.
2. Confirm migrator privileges and an approved maintenance/rollback window. Create the extension manually with an authorized DBA if the application role cannot.
3. Run `npm run db:validate` and `npm run db:migrate` only after verifying extension capability. Re-running migrate deploy is safe.
4. Confirm `SELECT extversion FROM pg_extension WHERE extname = 'vector';` and `SELECT COUNT(*) FROM note_chunks;`. Empty tables are expected immediately after migration.

Local Compose and the synthetic DB CI service now use `pgvector/pgvector:pg16` rather than plain `postgres:16-alpine`. Existing local volumes are not deleted or automatically migrated by this repository. Review and back up local data before an image switch. Production host availability and deployment have **not** been verified here.

## Invariants

- `@pce/core.chunkNoteText` uses NFC, LF line endings and **2048 Unicode code points** per chunk. It retains section (`original`, `summary`, `body`), section-relative code-point offsets, order and SHA-256 of normalized text. Content-addressed positional IDs include note ID, section, ordinal, normalized text hash and `unicode-nfc-lf-2048-v1`; a delayed embedding of changed text cannot attach to a replacement chunk at the same position. The source Markdown/original bytes remain unchanged in `notes`.
- **512 chunks per note** is the hard preparation bound. Oversized notes return `oversized` without partial insertion; future worker must report this metadata-only status rather than pretending the note is indexed. The body includes the original section by design, so this bound is cumulative.
- Chunk ownership is non-null and enforced by composite `(noteId, ownerSubject)` foreign key to `notes`. Legacy null-owner notes cannot be indexed. `sync`, `listCurrentByOwner` and `backfillPage` all require an explicit trusted owner. Authorization must still be performed before a caller reaches these server-only methods; this is **not** a token service.
- `sync` locks the owner-verified note row, compares all chunk hashes/versions/revisions, and leaves existing vectors intact for an unchanged note. A newer source revision deletes chunks and their vectors **inside the import transaction**, even if preparation had run earlier. A database trigger also invalidates chunks on direct updates of source text, source revision or content hash, including future #45 API writes. Re-preparation after that creates only new pending chunks. Historical revisions cannot silently keep searchable vectors.
- `chunk_embeddings` has a unique key per chunk, model and dimensions; status, lease/retry bookkeeping, and a nullable `vector(1536)` column. Database checks reject dimension mismatch and `READY` records without vectors. The first contract supports 1536 dimensions only; other model dimensions require a migration. Embedding writes and query indexes are future #47/#48 responsibilities.
- No provider API calls, outbound requests, background polling, autostart backfill, or production search interfaces are introduced. Storing chunks duplicates sensitive original text **inside PostgreSQL only**. Do not log/export them or expose them to unauthenticated clients.

## Opt-in, resumable backfill

`createNoteChunkRepository(prisma).backfillPage(ownerSubject, afterNoteId?, limit?)` returns at most 100 note IDs in ascending ID order. A trusted future worker can save the last processed ID in its own durable DB checkpoint, then call `sync(noteId, ownerSubject)` for each ID. `sync` is idempotent; reruns after a crash return `unchanged`. Do not use an ephemeral in-memory cursor or claim that the scan ran automatically. Changed revisions that occur after a page has passed require an independent durable DB job/reconciliation pass in #47.

## Checks and rollback

CI uses synthetic-only fixtures; its PostgreSQL job runs migration deploy twice, a schema diff and integration cases for extension vector dimensions, tenant isolation, replay, invalidation and backfill pagination. These are **not** tests of a real host or a production provider.

Before rolling back application code, stop any later indexing worker. Old code can ignore the additive tables safely. For an explicit destructive schema rollback, after confirming all derived data can be regenerated and no worker needs it, perform an operator-reviewed transaction:

```sql
BEGIN;
DROP TRIGGER IF EXISTS "notes_invalidate_chunks" ON "notes";
DROP FUNCTION IF EXISTS "invalidate_note_chunks_on_mutation"();
DROP TABLE IF EXISTS "chunk_embeddings";
DROP TABLE IF EXISTS "note_chunks";
DROP TYPE IF EXISTS "EmbeddingStatus";
DROP INDEX IF EXISTS "notes_id_ownerSubject_key";
COMMIT;
```

Leave the shared `vector` extension installed unless a DBA verifies nothing else uses it. Prisma's migration history is not automatically unwound by this SQL; reconcile it with Prisma's documented migration-resolution workflow before further deployments. Never drop original `notes`, `captures` or `processing_attempts`, and never delete private content as a rollback shortcut.
