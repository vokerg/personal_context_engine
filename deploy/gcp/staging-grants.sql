-- Run manually as the database administrator AFTER migration, against the
-- intended database only. Example: psql ... -v worker_role=pce-worker -f ...
-- Retains the existing deterministic preparation grants; no ownership/DDL,
-- DELETE, original UPDATE, auth-table or provider-secret access is added.
BEGIN;
GRANT SELECT, INSERT ON captures, notes, research_reports, tasks,
  task_sources, task_events, task_extraction_batches TO :"worker_role";
-- The research importer reads current indexing state even when egress is off.
GRANT SELECT ON research_chunks, research_embeddings TO :"worker_role";
GRANT SELECT ON ingestion_staging TO :"worker_role";
GRANT UPDATE (status, "leaseOwner", "leaseUntil", "attemptCount", "nextRetryAt",
  "lastErrorCode", "processedAt", "canonicalId") ON ingestion_staging TO :"worker_role";
GRANT INSERT ON db_processing_jobs TO :"worker_role";
COMMIT;
-- Acquisition is NOT granted to this consumer role. Mac/API use a separately
-- trusted role with INSERT on ingestion_staging and SELECT/INSERT/UPDATE on
-- ingestion_checkpoints. Never put a GitHub token on the GCP consumer.
