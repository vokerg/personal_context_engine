# iOS simulator checkpoint — 2026-10-25

Partial verification for [#131](https://github.com/vokerg/personal_context_engine/issues/131),
at the owner's request. Baseline: main `3834172`, containing native auth,
shell, timeline/search and note/research detail (#122–#125). Capture #126 and
native note management #127 remain open; this is not full App v1 acceptance.

## Actual environment

- Apple Silicon Mac, macOS 26.4.1, Xcode 26.6 (17F113).
- iOS 26.5 simulator runtime (23F77), iPhone 17, arm64 Debug build.
- Node 22.23.3, CocoaPods 1.17.0, Expo SDK 54, React Native 0.81.5.
- Hosted HTTPS issuer and explicitly registered `pce-ios` public client,
  exact `pce://oauth/callback` return URI, existing read/capture/tag scopes.
  The owner explicitly approved registration and deployment. No client secret.

Xcode, its runtime, CocoaPods and Watchman were installed locally. A duplicate
runtime registration appeared during setup; only the unusable duplicate was
removed, preserving the downloaded asset. The first simulator boot required
one shutdown/reboot before app launching responded normally.

## Observed result

1. Expo generated the native project and CocoaPods installed successfully
   (80 Podfile dependencies, 79 pods).
2. Xcode compiled the actual native app successfully for the iPhone simulator,
   using the workspace/scheme `PersonalContextEngine`, Debug configuration,
   arm64 and normal simulator signing. `simctl install` and `simctl launch`
   succeeded for bundle `dev.pce.mobile`.
3. The owner completed system-browser login and OAuth consent. The callback
   returned to the native app and the authenticated Notes timeline displayed
   hosted data. No token or note body was printed in validation logs or added
   to the repository.
4. The app was terminated and launched as a new process. It returned to the
   authenticated Notes timeline without another login. This exercises secure
   refresh persistence and the existing refresh-on-restore path; token values
   were not inspected.
5. The owner reported that the interactive screens appeared functional.
   Detailed per-screen, pagination and research-history acceptance was not
   systematically recorded. The native computer-use inspector failed during
   launch verification, so interaction was operator-assisted and screenshots
   were captured locally with the simulator tool. Private screenshots remain
   outside this public repository.

## Build problem found and corrected

The first manually invoked build used `CODE_SIGNING_ALLOWED=NO`. Compilation
and launch succeeded, but simulator `securityd` returned
`errSecMissingEntitlement` (-34018): the app lacked an application identifier
or Keychain access group. This caused the generic restoration/sign-in error
even though browser authentication succeeded.

Rebuilding with normal Xcode simulator signing generated the simulator
application identifier and fixed secure storage. Sign-in and subsequent
process-relaunch restoration then succeeded. This was a validation-command
error, not evidence of a server connectivity failure. Do not use the unsigned
build shortcut for interactive Keychain/OAuth verification. No paid developer
membership, device provisioning profile or real-device signing was used.

Expo doctor also found a React Native patch mismatch: 0.81.4 was installed,
while this Expo SDK requires 0.81.5. The mobile dependency and npm lockfile were
aligned, and doctor passed afterward. The source configuration now supplies a
stable simulator bundle identifier and documented local build commands.

## Executed checks

- `npm ci --no-audit --no-fund`: passed on the baseline before dependency
  alignment; `expo install react-native@0.81.5 --npm` updated the dependency.
- `npx expo-doctor` from `apps/mobile`: 18/18 passed after alignment.
- `npx expo export --platform ios --output-dir /tmp/pce-ios-export`: passed.
- `npx expo prebuild --platform ios --no-install`: passed.
- `pod install` in the generated iOS directory: passed.
- `xcodebuild` for the generated workspace and installed simulator: passed
  with normal simulator signing, after the initial setup/build failures above.
- `npm run typecheck`: passed.
- `npx vitest run apps/mobile`: 42 tests passed across 12 files.
- `npm test`: build passed; 291 tests passed, 74 database tests skipped because
  no disposable PostgreSQL test target was supplied for this checkpoint.
- Lint, formatting and documentation checks passed before this report; final
  PR evidence records the checks on the committed changes.

## Remaining gates

No actual iPhone, cellular connection, offline/expired/revoked grant scenarios,
VoiceOver, accessibility font-size sweep, complete filter/pagination matrix,
external source-link confirmation, background behavior or native push delivery
was verified here. The development build shows a React Native SafeAreaView
deprecation warning; no warning suppression was added. The browser consent
page renders with small default controls on the phone viewport and needs a
separate responsive-UI follow-up.

Capture and tag/removal screens remain their separate implementation issues.
No personal note mutation, GitHub content change, retrieval cutover,
TestFlight upload, App Store submission or release signing occurred. Keep
#131 open for the remaining device/read-write beta gates.
