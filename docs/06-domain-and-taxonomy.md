# 06 — Domain model, meaning and taxonomy

## Keep these entities distinct

| Entity | What it is | Key relationships |
| --- | --- | --- |
| **Capture** | One user utterance / text submission, with source and timestamp | May produce multiple Notes; original text must remain retrievable |
| **Note** | One durable meaning-bearing record with stable ID, original text and metadata | Belongs to a Capture; may reference projects, related Notes, candidates |
| **Action candidate** | Interpretation that some action may be useful | Can be dismissed, reviewed or promoted; **not an executed task** |
| **Task** | Explicitly accepted unit of work with lifecycle | May be linked to one or more Notes |
| **Reminder** | User-authorized schedule for bringing something back to attention | Linked to a Task or Note; has timezone, recurrence, notification policy |
| **Execution** | Logged attempt to change/send something outside the engine | Requires authorization and idempotency |
| **Ledger** | Reproducible view over source Notes and state for a time window/project | Tracks source IDs, generator version, evidence range |
| **Project** | A context for related notes and work | Identified independently from a folder path |

A Note describing "maybe email someone someday" is not the same as an accepted Task or permission to send email.

## Taxonomy dimensions

Proposed capture v1 fields:

- `kind` (one primary semantic type): `idea`, `task`, `memo`, `thought`, `decision`, `reference`.
- `domains` (zero or more broad spheres): e.g., `personal`, `work`, `development`, `learning`. These are initial suggestions, not universal categories.
- `projects` (zero or more stable slugs): e.g., `sample-project`.
- `tags` (zero or more topic labels): e.g., `training`, `finance`, `books`.
- `action_hint` (one advisory value): `none`, `consider`, `remind`, `review`, `follow_up`.
- `review_required`: boolean for missing context or uncertain classification.

Do not overload tags with type, project, state and execution instruction. The worker may normalize casing, whitespace and aliases (for example `coding` -> `development`) only through an explicit policy. Never discard original context due to unknown labels.

## Classification policy

1. Preserve explicit user intent over model inference.
2. A future-sounding phrase ("could", "maybe", "someday") does not imply a committed Task.
3. An explicit "remind me" may create a **reminder candidate**, subject to unambiguous timing and notification capability.
4. Multiple unrelated ideas in one utterance become several linked Notes.
5. Unknown project associations are empty or flagged for review; do not create arbitrary canonical project identities without policy.
6. Classifiers should state uncertainty instead of inventing deadlines or commitments.
7. A user may relabel notes later; models must not rewrite the historical original transcript.

## Suggested relational projection (conceptual)

```text
Capture(id, source, capturedAt, timezone, originalTextRef)
Note(id, captureId, title, kind, summary, originalText,
     capturedAt, occurredAt?, dueAt?, sourcePath, sourceRevision, contentHash)
NoteDomain(noteId, domain)
NoteProject(noteId, projectSlug)
NoteTag(noteId, tagSlug)
NoteRelation(fromNoteId, toNoteId, relationType)
ActionCandidate(id, noteId, actionHint, status, confidence?)
Task(id, sourceNoteId?, status, acceptedAt?, completedAt?)
Reminder(id, sourceNoteId?, dueAt, timezone, policy, status)
Ledger(id, scope, windowStart, windowEnd, sourceRevisionSet, generatorVersion)
ProcessingAttempt(id, noteId?, sourcePath, revision, status, errorCode)
NotificationDelivery(id, reminderId, deviceId, status, providerMessageId?)
```

This is a **domain sketch**, not a committed Prisma schema. Normalize timestamps in the DB and preserve the original offset/timezone. Define retention, uniqueness, FK behavior, access control and update semantics before migration.

## Human-facing states

Task status, note processing status, review status and notification delivery status are separate state machines. The UI may filter on all of them without moving Markdown files by category.

## Safe actions

Tags and `action_hint` can make a record eligible for **review or scheduling**, but they never directly authorize network calls, issue creation, purchases, calendar mutations or messaging. External actions require explicit, auditable policy and usually human approval.

See [capture contract](04-capture-contract.md) and [clients / notifications](08-clients-and-notifications.md).

## Tag exploration before canonical taxonomy (#51, #53, #54)

The immediate read model should expose **the set of tags that actually occurs in each owner's notes**, with deduplicated lowercase slugs, usage counts and stable owner-scoped filtering. The web UI should show a clickable tag catalog and chips on individual notes: clicking navigates to notes carrying that tag, combinable with date, type and project facets. Empty tags produce an empty state, not a fabricated default list.

**Not decided yet:** globally standardized tags, required categories, model-driven auto-renaming, synonym aliases, user-defined canonical tag management and cross-user shared dictionaries. Existing `tags`, `domains`, `projects` and `kind` remain separate concepts; do not change Markdown v1 syntax or silently rewrite captured tags to implement the first tag browser. See [the evolving intent](13-evolution-plan.md).
