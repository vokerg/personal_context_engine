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

## Optional taxonomy research and reversible alias approach (#54; not approved)

**Historical evaluation status (2026-10-18): proposed, not implemented.** The owner has since accepted candidate/approved tags and manual edits (D-025, #99/#103); only global defaults and aliases remain exploratory. Issues #51 and #53 now provide
owner-scoped *observed* tag facets and clickable tag filters. This is already useful
without a prescribed vocabulary. Decision D-018 remains in force: no default or
canonical tag policy has been accepted. No evidence of a production-wide tag
distribution or owner feedback is included here, and synthetic examples below
are not presented as observed personal usage.

### Options and decision criteria

| Option | Benefits | Costs / risks | Assessment |
| --- | --- | --- | --- |
| A. Keep observed tags only (current) | Preserves intent and fidelity; zero migration | Similar concepts may have separate facets | **Baseline** until evidence justifies change |
| B. Offer optional suggested tags at capture/relabel time | Encourages consistency without blocking new tags | Suggestions can bias capture or become de facto requirements | **First candidate**, explicitly dismissible |
| C. User-scoped aliases resolved in read projections | Lets historical variants group without rewriting sources | Ambiguous synonyms; count/filter/caching complexity | Candidate **only after owner review** and synthetic tests |
| D. Enforce one global canonical vocabulary | Simple centralized facet names | Loss of nuance, multilingual collisions, destructive lock-in | **Not recommended** without a separate product decision |

An optional curated list is **not** a list of mandatory tags. Keep user-defined
slugs and an empty tag list valid. Maintain `kind`, `domains`, `projects`
and `tags` as separate dimensions; do not convert project names or action
states into tags. Never transform a tag into a Task, Reminder or execution
authorization. In particular, the string `remind` is not a scheduling command.

### Evidence required before a policy decision

Collect only owner-authorized **aggregate** measurements from the owner-scoped
observed tag interface, preferably in a trusted local environment. Record a
time window, accessible-note count, distinct tag count, share of notes without
tags, singleton frequency, the 200-facet truncation flag and broad potential
duplicate categories. The current 200-item API cap is a browsing limit, **not
proof that only 200 tags exist**. No unscoped corpus scan or publication of
private tag names, counts tied to identifiable notes, snippets or source
originals in public PRs or CI. Do not treat test-fixture frequencies as usage
statistics. Owner-specific observations must not become cross-user defaults.

Ask the owner whether tag suggestions help at capture versus review time,
whether two apparently similar tags mean the same thing, what languages need
support, and whether changes should affect historical *views* or only future
capture. Record disagreement/unknowns as evidence against an alias, not an
excuse to silently consolidate. Gate adoption on representative evidence,
explicit owner authorization, privacy review and a separate schema/prompt PR.

### Candidate alias projection (design sketch, not a migration)

If approved, an owner-scoped mapping could store
`(owner_id, from_slug, to_slug, policy_version, enabled)`; this is a
**concept**, not a current table or Markdown v1 field. Each raw note retains
its original tag slugs and source revision. A derived read-only tag view may
resolve an enabled alias for display and filtering, with the original slug
available in note detail. Never rewrite private Markdown, imported originals,
existing note-tag rows or source history merely to introduce an alias.

A safe future implementation would need to:

1. Reject self-maps, cycles, ambiguous multi-target mappings and slugs outside
   the existing Markdown v1 grammar; define deterministic conflict handling
   for chains before any opt-in.
2. Enforce verified owner in every alias lookup, facet count and filtered-note
   query; **never** apply one owner's alias to another owner.
3. Compute canonicalized facet counts from **distinct accessible note IDs**
   after alias resolution, even when two source tags on one note collapse.
   Filtering the displayed alias must find all its active source members,
   while a disabled mapping restores the exact original facets.
4. Version and invalidate affected cached facet/search projections atomically
   with policy changes; expose the active policy version to clients when
   introduced. Existing observed-tag API behavior stays unchanged until an
   explicitly versioned, backward-compatible contract is reviewed.
5. Support immediate opt-out/rollback of the projection without irreversible
   data changes, external writes, notifications or tag-triggered side effects.
   Deleting a mapping must not delete or rename a source tag.

### Synthetic before/after examples (illustrative only)

| Original note tags | Optional owner-reviewed mapping | Read-time facet projection | Invariant |
| --- | --- | --- | --- |
| Note A: `[ml, research]`; Note B: `[machine-learning]` | `ml -> machine-learning` | `machine-learning` matches A and B; `research` remains | Both original tag arrays remain unchanged |
| Note C: `[ml, machine-learning]` | Same mapping | `machine-learning` has count **1** for C, not 2 | Count distinct notes |
| Note D: `[review]` | No mapping | `review` remains descriptive | No task or reminder created |
| Another owner's note: `[ml]` | Mapping enabled only for first owner | Other owner still sees `ml` | Owner isolation |

If the first owner disables the mapping, A/B/C revert to their previously
observed slugs and facet counts, with no source revision change. The samples
are not evidence that `ml` should actually mean `machine-learning`.

### Promotion / verification gate

Keep observed-tag-only behavior as the default. Before implementing B or C,
publish an **owner-approved** policy (scope, suggested labels, versioning,
original-tag visibility and opt-out semantics) and open a separate PR with
synthetic tests for multi-tag deduplication, unknown aliases, chains/cycles,
backward-compatible clients, stable filters, cross-owner isolation, malformed
input, policy toggling and rollback. Verify against a representative private
sample only in a trusted scope; summarize the result without exposing
personal taxonomy in the public repository. No automatic canonicalization,
prompt modification, schema migration or live-user-data mutation is
authorized by this research.

## Owner-approved candidate/approved tags and manual edits (D-025; #99, #103, #100)

**Accepted product behavior (2026-10-21), implementation pending.** Each note's
original Markdown v1 `tags` list is source classification, **not** an approved
vocabulary. A tag is **approved** only when its slug is present in the
owner-scoped PostgreSQL registry; other observed/LLM-suggested slugs are
**candidates**. A model may assign zero tags and should prefer useful approved
slugs over inventing many single-use labels. Approved status is an owner
decision, never an LLM self-promotion and never authorization to execute tasks.

The UI must support (a) clicking tag text to filter notes, (b) a distinct
one-click action to promote a candidate into the registry, and (c) attaching
and detaching tags on a specific note, including free-form newly added tags,
without implicitly approving them globally. Removing a tag from one note does
not delete it from the registry or other notes.

Preserve GitHub-sourced original text, file hash, historical slugs and
provenance: manual attach/detach is a database-side **effective-tag override**
with audit/concurrency rules, applied consistently to facets, filtering and
hybrid search. Imports and replay must not overwrite user edits. The registry
and note editing work with **no GitHub exporter**.

**Temporary ChatGPT bridge (#100):** a feature-flagged, one-way owner-approved
snapshot may be published at a dedicated path inside the verified private
content repo by a **new durable job handler in the existing worker** (not a
separate service). Coalesce changes, avoid duplicate commits by content hash,
retry safely, and expose lag; the interactive capture agent only **reads**
this snapshot and never modifies it. Turning off the exporter cannot break
capturing, tag editing, indexing or searching. Final ChatGPT Project prompt
integration belongs solely to #105 after the features are delivered. Earlier
#54 discussions of canonical/global taxonomies are superseded for the
candidate/approved workflow but remain relevant to optional aliases.
