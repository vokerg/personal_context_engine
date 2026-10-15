# 07 — Ledgers, aggregation and intelligence

## Why ledgers exist

An archive is useful only if information can be resurfaced when it matters. The purpose of ledgers is to convert a stream of independently captured notes into **auditable, periodically useful context**, without rewriting historical source records.

## Ledger versus narrative summary

- **Ledger facts:** deterministic counts, source-note lists, project associations, accepted task states, reminder schedules, decisions and open loops that are explicitly supported by stored data.
- **Narrative summary:** model-assisted synthesis, possible patterns and user-facing interpretation. Mark inferential language and support significant claims with source IDs.
- **Source records:** original captures/notes remain authoritative for what was actually said.

Do not recursively treat a previous LLM summary as primary factual evidence. Summaries can accelerate retrieval, but source notes and structured events must substantiate conclusions.

## Scopes

| Scope | Main questions | Typical source |
| --- | --- | --- |
| Daily | What was captured, decided, done, or left open today? | Notes/events assigned to one local calendar day |
| Weekly | What changed, recurred, advanced or stalled? | Period notes, task/reminder transitions and validated daily evidence |
| Monthly | What longer-term themes and commitments emerged? | Original period evidence plus structured events |
| Project | What is the evolving context and unresolved work for a given project? | Notes explicitly associated with the project, irrespective of date |

Initial daily, weekly and monthly aggregations may be triggered **interactively via ChatGPT**, without pretending an unattended LLM worker already exists. Automated generation later requires an explicit provider, budget, schedule and permissions.

## Proposed derived artifact contract

```yaml
schema_version: 1
ledger_id: daily-2026-10-15
scope: daily
period_start: 2026-10-15T00:00:00+02:00
period_end: 2026-10-16T00:00:00+02:00
timezone: Europe/Copenhagen
generated_at: 2026-10-16T08:00:00+02:00
generator: manual-chatgpt
source_note_ids:
  - 01K00000000000000000000001
source_revision_digest: synthetic-example-digest
status: complete
```

These values are **illustrative**, not production data or a finalized artifact schema. A real implementation must encode note/source revisions, generator version, scope and enough provenance for reproducibility.

## Pipeline

1. Select window in an IANA timezone and distinguish `captured_at`, `occurred_at` and `due_at`.
2. Query DB for notes and state transitions in the window, with stable pagination and explicit inclusion criteria.
3. Compute counts, changes, project mappings, and source-linkable evidence **deterministically**.
4. Optionally ask an LLM for a bounded interpretation over retrieved evidence; do not allow invented tasks, milestones, emotions or commitments.
5. Persist the resulting ledger to private content storage, and index its metadata/provenance in DB.
6. If a source note is corrected or arrives late, invalidate affected ledgers or mark them stale and make regeneration safe.
7. Protect against feedback loops: ledger files must not be re-ingested as primary user notes.

## Late events and timezone correctness

A note recorded today about something that happened last week can affect the past event timeline without changing when it was captured. Show both when relevant. Local day boundaries must use configured IANA timezones and daylight-saving transitions, not naive UTC midnight or hard-coded offsets.

## Source provenance

Each significant aggregate assertion should be traceable to source note IDs or structured task/reminder transitions. Any confidence estimate is optional and must not substitute for evidence. Store the prompt/model identifier for LLM-generated commentary when available, without exposing credentials or raw sensitive context in public logs.

## Future intelligence (deferred)

- Find links and recurring themes across notes.
- Create project-specific context packages for development agents with least-privilege access.
- Identify repeated but unresolved topics as **suggestions**, not diagnoses or facts about the person's motives.
- Use full-text search first; introduce embeddings/vector search only when supported by measured retrieval gaps.

See [domain model](06-domain-and-taxonomy.md) and [security](09-security-and-privacy.md).
