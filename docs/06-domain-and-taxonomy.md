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

## Manual effective note tags (#103; DB-authoritative)

The original Markdown v1 `tags` array on each Note remains a **source fact**; attaching or detaching a tag is **not a source revision** and never edits the private content repository. An authenticated owner action records a `NoteTagOverride` row for the verified `(ownerSubject,noteId)`: `added` tags, `removed` tombstones, a monotonically increasing `revision`, and `updatedAt`. Reads compute the effective set as `(source tags ∪ manual additions) − manual removals`, deduplicated and ordered. An original source tag removed by the user remains removed across importer replays and source revision changes; re-attaching clears its tombstone. Detaching a manual-only tag deletes its manual addition without creating a persistent tombstone, so a future source revision can introduce that slug as new source metadata. Detaching one note has no effect on other notes, registry approvals, source hashes or indexed original content.

Under a verified session with `tags:write`, `PATCH /api/v1/notes/:id/tags` accepts `{ "operation": "add" | "remove", "slug": "lowercase-tag", "expectedRevision": 0 }`. It returns the current effective `tags`, `changed`, and `tagEditing` (`sourceTags`, `manualAdded`, `manualRemoved`, `revision`). `GET /api/v1/notes/:id` and the search detail route also expose `tagEditing` when served by the DB reader; legacy clients can ignore it. A stale revision returns 409 `CONFLICT` without changing tags; the UI reloads the note before the owner retries. Missing/foreign-owner notes both return 404. Slugs must match the existing Markdown grammar; no per-note free-text fields, cross-owner selection, side effects or silent global approval. Cookie writes require the existing origin/CSRF checks, bearer writes require `tags:write`.

Owner-scoped catalog counts, observed-tag facets, the timeline/browse tag filter, note detail and hybrid search tag filters resolve **effective tags**, including API-only notes. The approved/candidate label still comes exclusively from the separate owner registry (#99); attaching an unapproved tag does not approve it. When the optional GitHub taxonomy exporter (#100) is unavailable, manual per-note editing remains functional. The note detail UI accepts a valid free-form slug or a suggestion from the observed/approved catalogs and exposes a separate Remove action. Activity tag chips are the approval control: clicking a candidate chip picks it into the owner registry, and clicking a picked chip unpicks it while preserving the note tag. Approved observed tags alone appear in the compact global tag browser and remain clickable filter chips. Source `tags` continue to be used when parsing, importing, recovering and refreshing original text embeddings.

Operational limits: existing response contracts bound a note to 100 effective slugs and observed catalogs to 200 entries. A truncated catalog is **not** proof that a slug is unknown. The initial UI does not provide tag undo history beyond reversible add/remove or full server-side catalog search; local agent/mobile accessibility acceptance is deferred to the combined feature check. No special ChatGPT Project prompt or GitHub write permission is required for manual editing.

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

**Accepted product behavior (2026-10-21; web interaction implemented in #112).** Each note's
original Markdown v1 `tags` list is source classification, **not** an approved
vocabulary. A tag is **approved** only when its slug is present in the
owner-scoped PostgreSQL registry; other observed/LLM-suggested slugs are
**candidates**. A model may assign zero tags and should prefer useful approved
slugs over inventing many single-use labels. Approved status is an owner
decision, never an LLM self-promotion and never authorization to execute tasks.

The web UI keeps the global tag browser to approved observed tags only. A
candidate remains visible on the activity/note carrying it; clicking that chip
promotes it into the owner registry and shows a check mark plus pressed state.
Clicking the same picked chip unpicks it through the same owner-scoped API
without removing the note tag. Approved global chips remain clickable filters.
Attaching a tag to a specific note, including a free-form newly added tag, does
not implicitly approve it. Removing a tag from one note does not delete it from
the registry or other notes.

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

### Approved-tag registry foundation (#99, draft PR #106)

The owner-curated vocabulary is an **independent PostgreSQL projection**, not a
change to Markdown v1, existing note tags, or ingestion provenance. An imported
tag absent from the approved registry is a candidate. Approval is an explicit
user action; attaching a tag to a note is a separate operation (#103).

- Owner-scoped `tag_approvals` stores approved slugs with optional display
  name, description, owner approval provenance and timestamps. Entries with no
  associated notes remain valid. No mandatory built-in tag set or global
  registry exists.
- `tag_registry_revisions` advances only on effective registry mutations and
  provides a stable revision for consumers. The capped response indicates
  `truncated` if there are more than 200 approvals, rather than claiming
  omitted slugs are known candidates.
- `GET /api/v1/tag-registry` requires `notes:read` and returns
  `{ revision, approved: [{ slug, displayName, description, noteCount,
  approvedAt }], truncated }`; counts use distinct notes scoped to the
  verified owner. `PUT /api/v1/tag-registry/:slug` requires `tags:write`
  and accepts optional `displayName` and `description`.
  `DELETE /api/v1/tag-registry/:slug` with `tags:write` unapproves; it never
  removes tag associations from any note. Both mutations return
  `{ slug, approved, changed, revision }` and are idempotent.
- Cookie-session writes additionally require matching Origin, CSRF cookie and
  `X-PCE-CSRF` header. Delegated `tags:write` is a separate optional
  OAuth scope. API routing requires an authenticated DB-backed adapter; the
  public/default unauthenticated API cannot mutate the registry.

Approved metadata must not be exported to GitHub implicitly; the removable,
feature-gated snapshot exporter is #100. Per-note effective tag overrides are
#103. The combined ChatGPT Project prompt remains blocked under #105.

## Saved research (#104)

A ResearchReport is an immutable generated interpretation linked to an existing,
owner-verified note/capture. Each refresh adds a report ID and successive series
revision; it never edits original input, summary or tags. Claims distinguish
sourced facts, user assertions, analysis and inference. PCE note IDs/revisions
and external URLs/dates are distinct sources. Search labels research explicitly;
report/source/history views remain separate from the original. See the executable
[research contract and operation](20-research-capture.md). Actual Project prompt
installation/acceptance remains #105.

### Full approved catalog access (#105)

The web owner catalog now uses authenticated server-side search and revision-bound
seek pagination, including unapproval beyond 200 entries. The legacy no-query
registry and optional GitHub snapshot retain their documented bounds. A bounded
window cannot establish candidate status for an omitted tag; show unverified
until its approval is known. See [integration and catalog operation](12-chatgpt-project.md).
## First-class Task implementation (#148)

Tasks now have independent PostgreSQL records, lifecycle and source links behind
an explicit API gate. Markdown v1 `kind: task` and tags still classify Notes and
never create a Task. Completion/reopen changes only the Task; reminders retain
their separate authorization. See [the Task contract](23-tasks.md) for implemented
limits and the remaining extraction/search/UI rollout under #147.
