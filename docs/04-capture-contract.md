# 04 — Capture and Markdown interchange contract (draft v1)

**Status:** version 1 is implemented as a pure parser/serializer in `packages/core/src/capture.ts` (issue #6). No persistence, API or ingestion pipeline is implied.

## Principles

1. **One utterance = one capture**; a capture can yield one or more notes.
2. Preserve the user's original **transcribed text** as received, including hedges, uncertainty, and language. Store raw audio only under a separate, future, explicit retention policy.
3. Each created note includes a useful title and precise normalized summary, without fabricating facts, due dates, project IDs, or action commitments.
4. Names, IDs and metadata keys are in English; summaries and the original input may remain in the user's language.
5. The ChatGPT agent writes to `inbox/` only after successful schema checks; it must not claim a write succeeded unless the tool confirms it.
6. Failed classification or missing permissions must **not** cause loss of the captured text. Report an unsaved draft plainly.

## Proposed YAML frontmatter

Required:

| Key | Type / values | Meaning |
| --- | --- | --- |
| `schema_version` | integer, currently `1` | Migration and validation |
| `id` | globally unique stable ULID or UUID | Identity independent of path |
| `capture_id` | globally unique ULID or UUID | Groups notes from one utterance |
| `captured_at` | ISO 8601 with offset | Time the input was captured |
| `source` | enum | `chatgpt_voice`, `chatgpt_text`, `mobile_voice`, `mobile_text`, `import` |
| `kind` | controlled enum | `idea`, `task`, `memo`, `thought`, `decision`, `reference` |
| `domains` | string array | Broad user-owned contexts |
| `projects` | string array | Explicit or strongly supported project associations |
| `tags` | string array | Free but normalized topical labels |
| `action_hint` | enum | `none`, `consider`, `remind`, `review`, `follow_up` |
| `review_required` | boolean | Indicates incomplete/ambiguous classification or action |
| `title` | nonempty string | Brief user-facing label |

Optional:

| Key | Type | Constraint |
| --- | --- | --- |
| `occurred_at` | ISO 8601 with offset | When the *described event* happened, if explicitly known |
| `due_at` | ISO 8601 with offset | Only when the user clearly supplies an unambiguous due time or confirms one |
| `timezone` | IANA timezone, e.g. `Europe/Copenhagen` | Associated user timezone when known |
| `related_note_ids` | array of stable IDs | Explicit provenance/relation |
| `processing_model` | string | Optional model/provider identifier; no prompts or secrets |

Every note body contains:

- `## Summary`: faithful concise paraphrase (no invented facts);
- `## Original input`: faithful transcription/text from this capture, including its original language. Preserve full utterance or an exact segment with sufficient context; record the common `capture_id`.

Optional `## Details`, `## Context` or `## Open questions` may add organization without replacing original input.

## Example

```md
---
schema_version: 1
id: 01K00000000000000000000001
capture_id: 01K00000000000000000000000
captured_at: 2026-10-15T08:30:00+02:00
source: chatgpt_voice
kind: idea
domains:
  - development
projects:
  - sample-project
tags:
  - training
  - feature
action_hint: consider
review_required: false
title: Targeted training for weak areas
---

# Targeted training for weak areas

## Summary

Consider a future training mode that focuses on areas with repeated mistakes.

## Original input

Maybe someday the trainer should focus only on the areas where I keep making mistakes. Not urgent.
```

The example is **synthetic**. An idea with `action_hint: consider` is not automatically a scheduled task. `due_at` should be absent unless grounded.

## Splitting multi-idea captures

If a single utterance includes "call a dentist tomorrow" and "consider a new game-training mode", emit **two** note files with the **same** `capture_id`, separate `id` values, relevant `kind` and `action_hint`, and an unchanged source transcript in the appropriate context. Retain enough verbatim source to reconstruct intent; an immutable capture record may be added later.

If a date like "tomorrow" cannot be resolved against a known capture timezone and reliable local date, leave `due_at` empty, mark `review_required: true`, and clarify before scheduling. Never guess time of day.

## Filename and location

Proposed inbox path: `inbox/<captured-date>_<note-id>.md`, for example `inbox/2026-10-15_01K00000000000000000000001.md`. The path is only a locator; **ID is the canonical identity**. After successful import, file moves to `notes/YYYY/MM/<note-id>.md` based on the capture date. The worker, not the LLM, owns finalization.

## Executable v1 conventions

The validator deliberately accepts a **restricted, deterministic subset of YAML**: one top-level mapping with unique, known keys; unquoted plain strings, single-quoted strings, or JSON-style double-quoted strings; literal `true`/`false`, integer `schema_version`, and string arrays as `[]`, JSON flow arrays, bare/single-quoted lowercase slug flow arrays for `domains`, `projects` and `tags`, or indented `- value` lines. It rejects aliases, anchors, tags, nested mappings, folded/literal block scalars, comments, ambiguous scalar syntax, unknown keys and duplicate fields. This restriction protects against unsafe YAML interpretation across parsers; YAML features outside the subset are not silently converted. The canonical serializer emits quoted strings.

- Input is strict UTF-8 (no replacement decoding and no UTF-8 byte-order mark), at most **1 MiB** with frontmatter at most **16 KiB**.
- IDs are uppercase Crockford ULIDs or canonical lowercase hyphenated UUIDs. The note and capture IDs differ; note IDs must be globally unique across a batch.
- `captured_at`, `occurred_at` and `due_at` require a Gregorian date, seconds, and a literal UTC offset (`Z` or `±HH:MM`). Up to three fractional-second digits are accepted. Both the original offset and optional IANA timezone are preserved unchanged.
- `domains`, `projects` and `tags` contain at most 100 distinct lowercase ASCII hyphenated slugs (max 64 characters each). They are **validated rather than silently rewritten**. Unknown but well-formed slugs stay intact and cannot trigger actions.
- The `# Title` heading must match `title`. `## Summary` precedes `## Original input`; optional descriptive sections should precede **Original input**, which is the final section. Everything after that heading is preserved byte-for-byte in the body, including Markdown headings and line endings. The exposed `originalInput` retains trailing newlines.
- `inboxNotePath` derives the path only from validated capture date and note ID; `verifyInboxNotePath` rejects anything other than that exact canonical path. Structured error codes and field names deliberately omit captured text.
- `groupNotesByCapture` permits multiple unique notes per capture, rejecting mismatched capture timestamp, source, or timezone. It does not persist or create captures, authorize reminders or infer due dates.

The **version 1 schema** is an executable interchange contract, not a claim that ingestion or private content storage is live.

## Validation requirements

- Strict UTF-8, YAML safety, size limits and a single allowed frontmatter document.
- Reject unknown schema versions until a migration is implemented; avoid silent reinterpretation.
- Validate IDs, timestamps, enum values, normalized tags and mandatory body headings.
- No trust in file path supplied by LLM; sanitize and constrain content paths.
- Blank/missing metadata and uncertain semantics must be repaired or flagged, not silently invented.
- Forward-compatibility requires explicit versioned migrations.

See [domain taxonomy](06-domain-and-taxonomy.md), [ingestion rules](05-ingestion.md), and [ChatGPT Project setup](12-chatgpt-project.md).

### Capture validation and formatting recovery (#40)

Before creating a note, use the executable validator where tools permit:
`npm run capture:validate -- /path/to/YYYY-MM-DD_<note-id>.md`.
It reports `valid`, or a content-free `code` and `field`. Correct formatting
and retry validation before saving. Never invent missing facts or alter the
original input to force validation. The canonical serializer still emits
quoted strings; the reader also accepts harmless `[personal, learning]` and
mixed quoted slug lists. This does not enable general YAML parsing, aliases,
anchors, tags, nested structures, comments or implicit scalar coercion.
Existing valid bytes are imported unchanged, including unquoted slug syntax.
Unrecoverable captures go through the worker's durable rejection flow and
remain under `rejected/`; a repaired revision is a new explicit capture-repair
operation, never silent deletion or model-invented content.
