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

Prerequisites: full Xcode with accepted license, CocoaPods, Node 22, `npm ci`, an unlocked iPhone trusted by the Mac, and Developer Mode enabled. Sign into Xcode > Settings > Accounts with your free Apple ID. On the first deployment, Expo may need to generate the ignored `apps/mobile/ios` project; if signing fails, open its `*.xcworkspace`, select the PCE target > Signing & Capabilities > Automatically manage signing > your **Personal Team**. You may need to complete certificate/profile/device registration in Xcode. Keep the existing `dev.pce.mobile` bundle identifier and native `pce://oauth/callback` scheme, and do not disable signing (Keychain entitlements are needed for session restoration).

Keep `EXPO_PUBLIC_API_BASE_URL` pointing at your hosted HTTPS API origin and `EXPO_PUBLIC_OAUTH_CLIENT_ID` pointing at the previously registered public iOS client in the ignored `apps/mobile/.env.local`. Never put client secrets, access tokens or private notes in these public variables. The API must recognize this client and callback, independently of any app build.

From the repository root:

~~~sh
node .agents/skills/ios-device-release/scripts/install.mjs --check
node .agents/skills/ios-device-release/scripts/install.mjs
~~~

The helper selects only a connected available **physical** iPhone; if several are present, pass `--device DEVICE_ID`. It checks the toolchain/configuration, prepares the shared packages, and runs the Expo iOS **Release** build, installation and launch as one operation. Release embeds the JS bundle and does not require Metro on subsequent launches. It **does not** use simulator-only `npm run dev:ios`, disable signing, uninstall data, or change production settings.

A free Personal Team install generally needs re-signing and reinstalling after 7 days. Re-run the helper when it expires. Preserve the app identity and signing team to retain data; data preservation across certificate/profile changes is not guaranteed. Validate OAuth callback, cold relaunch, iPhone connectivity and accessibility on the actual phone; none of these can be proven remotely.

Synthetic helper tests (portable; no device needed): `node --test .agents/skills/ios-device-release/scripts/validate.mjs`. They verify command arguments, public configuration parsing and physical-device selection, **not** a successful iPhone installation. Continue tracking real-device acceptance in #131.
