# Personal Context Engine — iOS application

App v1 targets **iOS only**, using the existing Expo SDK 54 / React Native 0.81
TypeScript workspace. Android scaffolding is preserved for possible later use;
no Android verification is required for the beta.

## Shell and navigation (#123)

The app uses **one dependency-free, typed native tab/detail navigator** built
from React Native `Pressable`/`View` and a pure `reduceNavigation` state
machine. This navigator is compatible with the current Expo SDK without adding
native navigation packages or changing the root npm lockfile. It intentionally
provides a simple single-level note detail stack rather than gesture-based
native-stack animations. Introducing a library navigator requires a separate
deliberate migration, not an unreviewed mix of navigators.

- `App.tsx`: root safe area, tab bar, OS back handling, auth gate and incoming
  external links. No `react-dom` or cookies.
- `navigation.ts`: typed Notes / Search / Capture / Settings tabs, note route,
  signed-out link intent, auth transition and private-state reset.
- `screens.tsx`: first-pass read-only note detail and Settings. Capture (#126)
  is explicitly unavailable until integrated; no fabricated saves or results.
- `feed-screens.tsx` / `feed-model.ts`: owner-scoped server-backed native
  timeline and search (#124). Both FlatLists remain mounted behind a note
  detail route to retain their scroll/query context on Back (and unmount on
  sign-out). Cursor pagination has abort/race guards, deduplication, one-time
  invalidated-cursor recovery and explicit retry. Pull down to refresh.
- Timeline groups notes by **device-local capture day**, with project/kind,
  approved-registry tag and date filtering applied on the server before paging.
  Date fields accept `YYYY-MM-DD`; the inclusive local day range converts to
  half-open UTC instants, respecting DST transitions. Facet lists can be
  incomplete and approved-tag pagination is explicit. Candidate tags do not
  appear in the approved tag filter.
- Search runs the existing authenticated lexical/hybrid API after short input
  debounce; it exposes API-reported mode/degradation, source revisions, match
  indicators and research provenance. Backend failures are **not** represented
  as successful semantic search. Search selection navigates to the owning note
  (research-specific detail/history follows in #125).
- A date range or selected filter is never used to filter only the first
  locally loaded page. No offline note replication/cache is introduced.
- `theme.ts`, `ui.tsx`, `screen-state.ts`: system/light/dark tokens,
  accessible controls and standardized loading/empty/error/retry states.
- `native-auth.ts` / `session.ts`: the existing #122 secure native OAuth
  session, unchanged. Screen requests use the shared `@pce/api-client`.

Accepted `pce://notes/<ULID>` routes contain IDs only. They are queued while
authentication is unavailable, consumed after sign-in, and fetched with the
owner-scoped API grant. Logout and session expiry clear private route state,
including stale pending intents. OAuth callback URLs are not note routes. This
is **navigation**, not a permission check.

Theme selection is currently in-memory for the running app session and does
not persist note content or tokens. Text scales with iOS accessibility settings.
Safe-area and visual/VoiceOver behavior are pending actual device inspection.

## Developer validation

From the repository root, use `npm ci`, then `npm run typecheck`,
`npm test`, `npm run lint` and `npm run format:check`. The mobile
navigation/theme/screen-state/feed tests run under Vitest with synthetic data;
they are not a real-device or React Native rendered integration test.

For an iOS development build, register the native public OAuth client and set
`EXPO_PUBLIC_API_BASE_URL` (HTTPS API origin) and
`EXPO_PUBLIC_OAUTH_CLIENT_ID` (public identifier, **not** a client secret).
Use `npm run dev:mobile` and an SDK54-compatible local iOS build. Expo Go does
not support the private callback contract. Do not put tokens, note text,
database credentials or confidential URLs in Expo public environment variables.

**Not verified remotely:** Xcode compilation, iOS simulator/phone launch,
native callback delivery, VoiceOver, keyboard/safe-area sizing, high Dynamic
Type, color appearance in-device, performance and offline networking. These
belong to the local #131 release gate.

Next screen owners: #125 note and research detail, #126 capture, #127 tags/removal;
add Reminders navigation only after #128–#130.
