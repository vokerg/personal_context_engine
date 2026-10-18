# 08 — Clients, reminders and notifications

## Product surfaces

**Web** (React + Vite): search, browse the timeline, inspect original and summarized notes, filter by project/type/tag/date, review action candidates, inspect ledgers, and manage task/reminder state as those features ship.

**Mobile** (React Native + Expo): a required product surface, not merely an optional companion. Its first value is **notifications plus browsing**; later it adds text/voice capture, searching, triage, and potentially offline reading.

Both clients share typed HTTP contracts and an API client, but platform-specific UI remains independent. Keep any shared React hooks free from DOM/native assumptions.

## API boundary

- Clients authenticate to the Fastify API. Issue #13 implements an interim one-hour HS256 JWT bearer verifier and `notes:read` scope; the final identity provider/login/token refresh mechanism is **not selected**. The shared API client accepts a per-request token provider, and the two UIs now offer a **development-only**, memory-only bearer entry for synthetic list/detail requests. Neither implements token issuance, refresh or production login; the default API still has no private note reader.
- API owns authorization, read projections and user-approved commands.
- Clients never receive GitHub personal access tokens, `DATABASE_URL`, worker credentials, or private content repository write access.
- Note creation through mobile will go through an authenticated API ingestion path; it must create a durable capture and maintain the same schema/provenance guarantees as ChatGPT ingestion.
- Editing canonical Markdown through the app is **deferred** until write-back and conflict semantics are decided.

## Reminder semantics

A reminder differs from a note containing the word "remember". Its lifecycle needs:

```text
candidate -> reviewed/accepted -> scheduled -> due -> delivered/failed -> completed/dismissed
```

The state machine above is illustrative; the actual DB schema will distinguish reminder state, execution attempts, notification deliveries and user acknowledgement.

- `due_at` must be explicit and timezone aware. Do not guess dates or local times.
- Recurring reminders require a separately defined schedule model and DST handling.
- User can review, opt in/out, snooze, complete or dismiss when those controls exist.
- The system should prevent duplicate active reminders and duplicate notification sends on retry.
- Quiet hours, notification channels and escalation policies are **deferred**, but the scheduling model must leave room for them.

## Proposed push architecture

```mermaid
sequenceDiagram
  participant App as Expo mobile app
  participant API as Fastify API
  participant DB as PostgreSQL
  participant W as Reminder worker
  participant P as Push provider
  App->>App: Request notification permission
  App->>API: Register/update device token (authenticated)
  API->>DB: Store device registration
  W->>DB: Query due accepted reminders
  W->>DB: Reserve idempotent delivery attempt
  W->>P: Send provider message
  P-->>W: Accepted / transient error / permanent error
  W->>DB: Record outcome and next retry
  P-->>App: Best-effort push delivery
  App->>API: Open referenced reminder or note
```

**Important:** a push provider acknowledging a request does **not** guarantee that a device received or displayed a notification. Show real delivery/acknowledgement state without overstating guarantees. Test foreground, background, offline and revoked-permission cases on actual iOS/Android devices.

## Mobile-first minimum value

1. User authentication and registered device.
2. Read-only timeline and note detail from API.
3. List of scheduled/open reminders and user-triggered completion/dismissal (once reminder API exists).
4. Opt-in push notifications for explicit reminders, with deduplicated attempts.
5. Deep links from a push to the underlying item.

Text/voice capture, offline cache, rich editing and automatic proactive insights come after this baseline.

## Testing expectations

- Typed API contract tests shared by web/mobile.
- Permission-denied and token-expiration behavior.
- Duplicate push event and worker restart safety.
- UTC/local timezone transitions and daylight-saving time.
- Deep-link authorization (a notification does not bypass authentication).
- Device-level testing; simulator checks alone are insufficient for all push cases.

See [domain model](06-domain-and-taxonomy.md), [ingestion](05-ingestion.md) and [roadmap](10-roadmap.md).

## Web information architecture priorities (#51–#53)

The current web UI is a functional local-development preview, not the target experience. Build a coherent responsive note timeline grouped by day, approachable list/detail navigation, original and structured text, useful empty/loading/error states, paging, date/project/kind filters and search. Treat session state and owner scoping as non-negotiable.

Next, expose **observed, per-user tag facets** via the authenticated API, show clickable tag chips and an exploratory tag browser with counts, and allow combined filtering plus easy reset/back navigation. Do **not** ship fixed standard tags or arbitrary implicit note mutations yet; tag normalization/taxonomy needs a separate product decision (#54). Web redesign (#52) may use lexical filtering while DB hybrid search remains gated, and the mobile product stays a future workstream. Notification scheduler, real push and device testing are not delivered by this documentation work.


### Owner-scoped observed tag API (#51)

For an explicitly enabled private note adapter, `GET /api/v1/tags` provides
up to **200** observed slug/count pairs in bytewise slug order; `truncated:
true` indicates more than 200 distinct tags, rather than inventing a standard
dictionary. Each count is the number of distinct accessible notes tagged
with that slug. The opt-in local reader further limits counts to note IDs in
the current content snapshot, excluding stale/removed file records.

`GET /api/v1/notes` accepts optional `tag`, `project`, `kind`, `from`
and `to` query parameters; combined filters are conjunctive. Slugs follow
Markdown v1 and the date range is over inclusive **UTC** calendar days of
`capturedAt`. Invalid values, duplicate keys and unknown fields get a
generic 400 without echoing private inputs. A verified `notes:read` token
is required for both routes. Owner scoping is enforced at the database query,
not in the browser. Production identity (#44), note pagination (#52), curated
tags (#54) and DB search (#48) remain separate work.

## Web timeline shell implementation (#52, staged)

The opt-in local/development React client now has a responsive **read-only timeline shell** with
calendar-day grouping in the viewer's timezone, a selected-note detail panel,
a Back control and browser back/forward navigation by stable note ID.
Authenticated requests continue to use the short-lived in-memory token; the
URL contains a note ID by default; #53 adds explicit opt-in structured filter
sharing. It never contains note text, a search query, or a bearer token.
Original note bodies are rendered as literal text rather than interpreted HTML.

The current notes-list response has **no server paging or full-text query** and
exposes ID/title/summary/capture timestamp plus optional observed tags. Consequently, keyword and local
calendar-date filters operate **only on the returned list**; "Show more"
reveals another bounded page of already fetched notes rather than requesting
more from PostgreSQL. Results are not comprehensive if the API limits its
response. Project, kind and observed-tag facets are now available through the owner-scoped
API (#51) and integrated into the web controls (#53). Full-text server
search remains separate (#48); neither capability should be faked by the browser. Production authentication (#44), viewport
screenshots and trusted real-data validation remain separate rollout gates.

The UI keeps separate loading, retryable failure, missing-detail and no-results
states; ingestion status is available only in the local workspace and must not
be interpreted as a hosted 24/7 worker. Synthetic helper tests cover mixed-offset
calendar days, combined filter predicates and stable ordering.

## Clickable tags and combined filters (#53)

The web client now loads the authenticated observed-tag catalog with counts,
loading/error/retry/empty states and an explicit notice when the 200-tag cap is
reached. Counts cover all notes available to the session, independently of the
current filters. Chips on list/detail notes use optional API-provided `tags`;
older DTOs without tags remain valid. No canonical tag list or normalization is
introduced. Catalog/chip clicks filter through the existing owner-scoped API.

Tag, project slug and kind are conjunctive server filters. Keyword search remains
local to returned titles/summaries, and local-calendar date bounds remain client
filters (the API's own UTC date semantics are unchanged). Invalid project slugs
are rejected before requesting data. Each request is cancellable and late results
cannot replace a newer selection.

Detail/Back and browser back/forward preserve filter context in React memory.
Filters stay out of the address by default. **Share filtered view** explicitly
adds tag/project/kind/local-date bounds to the current address, which can then be
copied; those metadata values become part of browser history and a shared link.
Free-text search, tokens and note bodies are never serialized. Remove filters
from link reverses this choice; Reset clears all filters and selected detail.
Shared links still require an authorized session, validate structured parameters
and cannot request another owner. Clear session/expiry clears notes, tags, filters
and URL metadata; no bearer or note storage is introduced.

This uses the existing trusted local owner-aware preview. Production identity
(#44), complete #52 paging, hosted ingestion and ChatGPT search cutover remain
separate; backup automation is deferred under D-020 and does not block this UX.
