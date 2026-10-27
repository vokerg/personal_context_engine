# Personal Context Engine — iOS application

App v1 targets **iOS only**, using the existing Expo SDK 54 / React Native 0.81
TypeScript workspace. Android scaffolding is preserved for possible later use;
no Android verification is required for the beta.

## Shell and navigation (#123)

The app uses **one dependency-free, typed native tab/detail navigator** built
from React Native `Pressable`/`View` and a pure `reduceNavigation` state
machine. This navigator is compatible with the current Expo SDK without adding
native navigation packages or changing the root npm lockfile. It provides a bounded note/source stack with a deliberate rightward swipe
from the left edge to go Back, alongside the accessible Back button. It does
not implement interactive native-stack animations. Introducing a library navigator requires a separate
deliberate migration, not an unreviewed mix of navigators.

- `App.tsx`: root safe area, tab bar, OS back handling, auth gate and incoming
  external links. No `react-dom` or cookies.
- `navigation.ts`: typed Notes / Search / Capture / Settings tabs, note route,
  signed-out link intent, auth transition and private-state reset.
- `screens.tsx`: Settings and legacy read-only notes preview. `detail-screen.tsx` provides owner-gated originals/research detail (#125). Capture (#126)
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

## Native note and research detail (#125)

Opening a note from the timeline, search or a canonical `pce://notes/<id>`
link makes an owner-scoped `getNote` request. It displays the API's
`originalInput` **verbatim as plain native text** when available; a missing
original is explicitly labelled missing, never reconstructed from `body`
or the derived `summary`. The stored body is displayed separately.
Capture metadata, source, kind, project and effective tags are shown only
when supplied by the note DTO. No web rendering or executable Markdown.

After the note is authorized, the screen independently requests
`getResearchForNote`. If enabled, saved report revisions and statuses are
listed, sorted newest first; selecting one invokes `getResearchReport` and
checks report ID, series, revision, parent-note ID and content hash against
the selected history entry. Only verified persisted report contents are
shown: findings, limitations, status, retrieval/degradation, sourced claims,
external URLs, source note IDs and **recorded** source revisions. A draft
remains labelled a draft; indexing state is distinct from research status.
Missing/disabled research, no saved reports, 403, transport errors and stale
revisions have separate visible states, with explicit reload. Research is
never generated from this view.

Source-note navigation is **ID-only and authorization-gated** by the same
notes API. Back returns through up to 20 cited notes before restoring the
previous timeline or search selection. An incoming deep link starts a fresh
stack. Logout and session expiry unmount private screens, cancel in-flight
requests and erase the navigation stack. No private content is cached in
device storage. External HTTP(S) sources are not automatically launched:
the user must confirm a third-party URL first, and unsafe schemes or
credentialed URLs are rejected.

Synthetic coverage: `detail-model.test.ts`,
`detail-contract.test.ts`, `detail-screen.render.test.tsx` and source
navigation cases in `navigation.test.ts`. These exercise typed contract
parsing, original-vs-derived fidelity, reported source revisions, report
identity, safe links, initial unauthorized loading and reset behavior.
Real iOS/device, VoiceOver, link-opening UI, offline and Dynamic Type
checks are **still pending local #131**.

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

### Local simulator build (#131)

Install full Xcode (the standalone Command Line Tools are insufficient), its
iOS simulator runtime, CocoaPods and Watchman. Use Node 22, matching `.nvmrc`.
The app uses Expo SDK 54's required React Native 0.81.5 patch and the local
simulator bundle identifier `dev.pce.mobile`; no signing team or paid developer
account is needed for a simulator build.
Keep Xcode's default simulator signing enabled. Setting
`CODE_SIGNING_ALLOWED=NO` can compile an app that launches but cannot access
Keychain: actual local testing returned `errSecMissingEntitlement` (-34018),
preventing secure session restoration and completion of sign-in. A simulator
build with Xcode's normal generated application identifier restored Keychain
access without a developer-program membership or provisioning profile.

Put the two public mobile settings above in ignored `apps/mobile/.env.local`.
The server must independently register that exact client and
`pce://oauth/callback`; a build setting does not grant API access. An absent
configuration shows the explicit configuration screen, rather than fabricating
a signed-in session.

From the repository root:

```sh
npm ci
npm run dev:ios
```

The root command builds shared packages, then `expo run:ios` generates the
ignored `apps/mobile/ios` project, installs its pods, compiles and launches the
app with Metro. To select a particular installed iPhone simulator, run
`npm run dev:prepare`, then `npm run ios -w @pce/mobile -- --device`.
Native generated files and machine-specific paths must
not be committed. After changing a native dependency or Expo configuration,
regenerate with `npx expo prebuild --platform ios` from `apps/mobile`, then run
the build again. Expo may add an Android script while generating its package
scripts; Android validation remains outside this iOS checkpoint.

For JS-only validation, run `npx expo-doctor` and
`npx expo export --platform ios --output-dir /tmp/pce-ios-export` from
`apps/mobile`. A successful export does not prove Xcode compilation, simulator
launch or OAuth callback delivery.

The [2026-10-25 simulator checkpoint](../../docs/evidence/issue-131/2026-10-25-simulator.md)
records a successful local iPhone 17 / iOS 26.5 build, hosted native sign-in,
authenticated timeline and session restoration after process relaunch. This is
a partial #131 checkpoint; it does not close the read/write beta gate.

**Not verified remotely:** Xcode compilation, iOS simulator/phone launch,
native callback delivery, VoiceOver, keyboard/safe-area sizing, high Dynamic
Type, color appearance in-device, performance and offline networking. These
belong to the local #131 release gate.

Next screen owners: #126 capture, #127 tags/removal;
add Reminders navigation only after #128–#130.

### Physical iPhone standalone Release (free Apple ID)

To install the PCE app for personal use without Expo Go, EAS, TestFlight or a paid Apple Developer account, run the repository-local Codex skill [ios-device-release](../../.agents/skills/ios-device-release/SKILL.md) **on the Mac with the phone attached**. You can invoke it in Codex with `$ios-device-release` or run the helper directly.

Prerequisites: full Xcode with accepted license, CocoaPods, Node 22, `npm ci`, and an unlocked iPhone trusted by the Mac. Enable Settings > Privacy & Security > Developer Mode on the phone, restart it, then confirm enabling the mode after reboot. Let Xcode > Window > Devices and Simulators finish preparing its developer disk image (DDI). Sign into Xcode > Settings > Apple Accounts with your free Apple ID. Open the ignored `apps/mobile/ios/*.xcworkspace`, select the PCE target > Signing & Capabilities > Automatically manage signing > your **Personal Team** for Release (or all configurations). If the workspace is absent, first generate it with `npm exec -w @pce/mobile -- expo prebuild --platform ios` without `--clean`; inspect and exclude incidental tracked-file changes. Complete any certificate/profile/device registration in Apple's UI. Keep the existing `dev.pce.mobile` bundle identifier and native `pce://oauth/callback` scheme, and do not disable signing (Keychain entitlements are needed for session restoration).

Keep `EXPO_PUBLIC_API_BASE_URL` pointing at your hosted HTTPS API origin and `EXPO_PUBLIC_OAUTH_CLIENT_ID` pointing at the previously registered public iOS client in the ignored `apps/mobile/.env.local`. Never put client secrets, access tokens or private notes in these public variables. The API must recognize this client and callback, independently of any app build.

From the repository root:

~~~sh
node .agents/skills/ios-device-release/scripts/install.mjs --check
node .agents/skills/ios-device-release/scripts/install.mjs
~~~

The helper selects only a connected available **physical** iPhone; if several are present, pass `--device DEVICE_ID`. It checks the toolchain/configuration, Developer Mode, DDI services and a valid local signing identity before preparing shared packages. An available Xcode inventory entry alone is insufficient. App/device provisioning is checked by the actual build. It then runs the Expo iOS **Release** build, installation and launch as one operation. Release embeds the JS bundle and does not require Metro on subsequent launches. Existing public feature flags in `.env.local` are preserved. It does not disable signing, uninstall data, or change production settings.

A free Personal Team install generally needs re-signing and reinstalling after 7 days. Re-run the helper when it expires. Preserve the app identity and signing team to retain data; data preservation across certificate/profile changes is not guaranteed. Validate OAuth callback, cold relaunch, iPhone connectivity and accessibility on the actual phone; none of these can be proven remotely.

Synthetic helper tests (portable; no device needed): `node --test .agents/skills/ios-device-release/scripts/validate.mjs`. They verify command arguments, public configuration parsing and physical-device selection, **not** a successful iPhone installation. Continue tracking real-device acceptance in #131.

The [2026-10-27 physical-iPhone checkpoint](../../docs/evidence/issue-131/2026-10-27-iphone-release.md)
records first-time Apple Account/Personal Team setup, missing WWDR G3 recovery
and the actual local deployment results. Use the linked skill for repeat installs;
keep machine-specific signing configuration and all private artifacts local.

## Floating iOS menu (#142)

The existing typed tab/detail navigator now renders a floating rounded menu
with SF Symbols and an `expo-glass-effect` native glass surface on supported
iOS 26+ builds. This is a custom menu, not a migration to a system tab-bar
controller: system tab morphing and minimize-on-scroll are not implemented.
Opaque item backgrounds are removed so scrolling content can show through.
Timeline/search and the Capture/Settings scroll views reserve a bottom inset
based on the measured menu height, including when text size changes. Detail
continues to hide the menu; session and navigation behavior are unchanged.

The menu starts opaque until the Reduce Transparency preference is known and
follows live preference changes. Unsupported systems/builds and reduced
transparency use the existing theme's opaque surface. Light/dark app appearance
is passed to the glass view. Native dependencies use Expo SDK54-compatible
versions; rebuild the iOS development app after pulling this change (a Metro
reload alone cannot install the native modules).

Physical-device appearance, VoiceOver and the largest Dynamic Type sizes remain
manual verification items; automated checks do not establish visual quality.

Local verification on 2026-10-25: the Xcode 26.6 build installed and launched on
an iPhone 17 / iOS 26.5 simulator. The floating material was visually inspected
in light and dark app appearance; all four tabs opened, and system appearance
was restored afterward. No personal screenshots are stored in the repository.
Synthetic menu tests cover live transparency changes, unsupported-build fallback,
accessible selected labels, tab dispatch and subscription cleanup.

## Optional native Tasks (#152)

`EXPO_PUBLIC_PCE_TASKS=true` adds a native Tasks tab to the existing iOS shell.
It defaults off. Open, Completed and All use dedicated server Task queries;
source Notes, Note kind/tags and reminders remain independent. The virtualized
list supports server search/paging, checkbox completion after acknowledgement,
reopen, detail/history and authenticated source Note navigation. Returning from
a source preserves the Task view. The existing menu/Reduce Transparency fallback
and system/light/dark palettes are reused; no platform router or signing change.

Task creation is an explicit title/optional description form. Keyboard dictation
fills these fields; there is no model, NLP heuristic, automatic extraction,
inferred date, reminder or provider charge in this native path. Quick Note capture
#126 and Note management #127 remain separate existing work; this feature does
not complete them or the App v1 epic #121.

Before release, explicitly enable the API Task gate and extend only the reviewed
native OAuth registration with `tasks:read` and `tasks:write`, preserving the
registered `pce://oauth/callback`. The enabled build requests those scopes alongside
its existing scopes and the user must reconnect/consent. Existing grants and
refresh never gain privileges; missing access shows reconnect guidance. Disabling
the build flag restores the existing four tabs and requested scopes; a previously
broader saved grant may require fresh sign-in. Never change production registration
or user credentials just to satisfy a synthetic test.

Duplicate taps are blocked before a request can be issued twice. An uncertain
completion/creation retains its exact command/Task ID and payload for an explicit
in-memory retry. A 409 clears the stale command and reloads for a new decision;
no completed state is shown before acknowledgement. Requests use the existing
secure session's refresh-aware token provider, typed HTTPS transport and safe
errors. No Task text, query or pending command is persisted outside memory. On
restart/logout inspect server Tasks before manually recreating an uncertain
creation; this is not an offline queue. Completion history stays in PostgreSQL.

Synthetic tests cover native controls, archive/reopen/search, source navigation,
auth scope selection, stale revisions, stable retry IDs and duplicate presses.
`expo export --platform ios` with explicit synthetic public config and dotenv
loading disabled passed. This is JavaScript bundling, **not native compilation or
iPhone/Simulator acceptance**. Actual font scaling, VoiceOver announcements,
five-tab safe areas, keychain/auth refresh, offline/background/restart and real
Task writes belong to the final #131/#154 approved synthetic device pass. No
TestFlight, push or Android acceptance work is included.

## iOS usability fixes (#165)

The generated opaque 1024×1024 icon is tracked in `assets/icon.png` and selected
by Expo configuration. Regenerate/rebuild the native app to install it.
The menu's GlassView now contains the tab buttons and owns their measured
layout, rather than using a separate absolutely positioned glass sibling.
Its outer view anchors it 12 points above the shell's bottom safe area; list
insets continue to follow the actual menu height. Opaque accessibility fallback
is retained.

Note/source and Task detail accept a one-finger rightward edge swipe (starting within
36 points of the left edge). Short, vertical and non-edge gestures do not pop
the existing stack. The visible Back control remains available. This is a JS
responder gesture, not an interactive UIKit navigation transition.

Visible Notes/Search/Tasks revalidate on tab/detail return, foreground return,
and every 30 seconds while the app is active. Background/hidden screens do not
poll. Busy list requests are not replaced by periodic refresh; Tasks also avoids
polling during mutation, detail viewing and creation. Notes/Search retain the
visible list while the first page refreshes, invalidate older pagination and
reload facets/approved tags. Tasks retains its list during revalidation and
supports pull-to-refresh on both the list and detail/history. All three
lists enable vertical bounce for short or empty results. Note detail also
supports pull-to-refresh, re-reading the owner-scoped note and its research
history with the existing cancellation guards. This is bounded polling,
not worker push or an offline cache; no worker/service change is needed.

After password sign-in (or restoration of a browser session), the web login
resumes the pending authorization request automatically at the configured API's
fixed OAuth path. Server-side callback/scope/PKCE validation and CSRF-protected
Allow/Deny remain mandatory. Consent includes a mobile viewport and 52-point
minimum button height. No second native Sign in press is required by this flow.

Synthetic checks cover gesture thresholds, active/hidden refresh subscription
lifecycle, pagination cancellation, login continuation and mobile consent/CSRF.
Physical-device swipe behavior, exact glass placement, safe areas, Dynamic Type
and the complete hosted system-browser login need validation on a rebuilt app;
a JavaScript bundle or synthetic test cannot establish these outcomes.
