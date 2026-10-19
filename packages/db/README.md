# Database projection (issue #8)

This package is a **server-only** Prisma/PostgreSQL projection of strictly
validated Markdown v1. It contains original text for replay/query, but Markdown
in the content repository remains the first-stage source of truth. It is never
imported into the browser or Expo clients.

## Local setup

Node 22.12+, npm 10+, Docker with the Compose plugin and a reachable local
PostgreSQL 16 database are needed for the full database test:

```bash
docker compose --profile db up -d postgres
export DATABASE_URL='postgresql://pce:pce_dev_only@127.0.0.1:5432/pce?schema=public'
npm ci
npm run db:validate
npm run prisma:generate
npm run db:migrate
PCE_DB_TEST_URL="$DATABASE_URL" npx vitest run packages/db/src/index.integration.test.ts
```

`db:migrate` uses **migrate deploy**, not `db push`, and is safe to repeat.
For developing a new checked-in migration use `npm run db:migrate:dev` against
a disposable local DB only. Prisma migration history is source-controlled.

The standard `npm test` runs without PostgreSQL and skips the DB integration
suite unless `PCE_DB_TEST_URL` is set. The `PostgreSQL integration` GitHub
Actions job exercises migrations and tests with a **synthetic-only**
PostgreSQL 16 service. Public CI never touches the private content repo.
No local Docker or production database execution is claimed by this PR.

## Projection contract and safety

`createNoteRepository(prisma).importMarkdown({markdown, sourcePath, sourceRevision,
expectedPreviousRevision?})` validates the original Markdown and canonical
inbox path; computes SHA-256 of the supplied UTF-8 bytes; and uses a
**serializable transaction** to keep capture and note projection consistent.

- Permanent v1 note ID is the primary key. The source path/revision pair is
  unique, and source offsets are saved alongside UTC timestamps.
- Same note ID, same revision and same hash yields `replayed`; a mismatch
  under an unchanged revision raises a content-free conflict code.
- Changed source revision requires explicit `expectedPreviousRevision`
  (optimistic compare-and-swap). Once updated, note state returns to
  `PERSISTED` pending safe content finalization. An arbitrary older
  revision cannot silently replace a newer one.
- One capture may contain many notes. The capture row records the first
  imported original-text segment; each note retains its **own exact original
  segment**. Future capture fidelity work may add a full-utterance invariant.
- Capture deletion is **RESTRICT** while notes exist. Processing-attempt
  records can retain source/revision/error metadata if a note is removed;
  their optional note foreign key is set null rather than cascading.
  There is **no automatic deletion when a Markdown source disappears**.
- The `processing_attempts` table reserves unique per-revision attempt
  state, lease timestamps and retry metadata. The opt-in issue #10 worker owns the
  lease state machine and finalizes only after persistence.
- Never log connection strings, Markdown bodies, SQL error text or private
  repository URLs. The API wires only a database health probe when the
  database is configured. It still exposes **no private notes endpoints**
  pending authentication/authorization in issue #13.
- PostgreSQL is not a source of independently editable truth. No direct
  client access and no public CI credentials beyond a fake local DB.

**Known limits:** Cross-system Git/DB commits are not atomic; import does not
yet finalize files, reject bad inputs in ContentStore, or reconcile interrupted
moves. The issue #10 worker now implements these with revision checks and restart reconciliation; real private-repository deployment remains unverified.
Ownership/auth storage is deliberately deferred to issue #13, before any
private HTTP routes. A real PostgreSQL service, migration check and
concurrency tests are verified only by the hosted Actions job, not by a local
Docker instance.


## Ingestion checkpoints (#43)

The additive `ingestion_checkpoints` table stores a trusted source-scope hash,
seek cursor/version, scan timestamp, local observed/reconciled Git revision and
previously seen note IDs. Progress is committed after durable attempt/import
results; a discovery cursor does not assert that all notes imported. Old code
ignores this table. Roll back code with workers stopped and retain the table;
never reset source notes or attempt history to reset a scan. See the
[ingestion runbook](../../docs/05-ingestion.md#durable-local-reconciliation-43).

## Optional pgvector chunks (#46)

The additive pgvector schema requires the extension available before migration deployment. Synthetic local Compose and database CI use a pgvector-enabled PostgreSQL 16 image. Source-note import is unchanged except that a revised source atomically invalidates old chunks and vectors; replay leaves indexed chunks intact. Chunk preparation is **manual/server-only**, not an embedding worker or API route. Only verified, non-null note owners may prepare or read chunks. See [storage/preflight/rollback runbook](../../docs/16-embedding-storage.md); do not migrate an unverified production host without checking extension installation and privileges.
