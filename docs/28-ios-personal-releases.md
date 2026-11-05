# Private personal iPhone releases (#182)

This local Mac workflow builds the existing Expo SDK 54 / React Native 0.81.5
application for a physical iPhone. It uses the existing free Personal Team,
`dev.pce.mobile`, `pce://oauth/callback` and Keychain identity. It neither
exports through App Store distribution nor needs a paid developer membership.
No GitHub release, public artifact, backend deployment or background PCE job is
created. Hosted frontend/worker workflows are unrelated to this release path.

## Regular release

From an up-to-date checkout with dependencies installed:

```sh
./scripts/ios/release.sh --install
```

This compiles a fresh signed Release, validates and packages an IPA, installs
with `devicectl` without uninstalling, then requests launch. Xcode's UI and a
Metro server are unnecessary during an ordinary update while provisioning is
valid. Unlock the paired phone. Cable is the most reliable transport; a paired,
prepared device can also be available through Xcode's wireless connection.
The command builds the **current checkout**; it never pulls or switches branches.
After merging changes, explicitly update your local `main` before releasing.

Omit `--install` to only build/package. Optional arguments:

```sh
./scripts/ios/release.sh --version 0.1.1 --build 123 --notes /private/path/release-notes.txt
./scripts/ios/release.sh --install --device DEVICE_ID
```

Default version comes from `apps/mobile/app.json`; the default build is an
increasing Unix timestamp. An explicit build must exceed the existing baseline and prior local releases.
Version/build are supplied through a temporary Info.plist before Xcode signs;
the original native project and signed output are never patched afterward.
Builds are repeatable, **not byte-for-byte reproducible**: signing times,
provisioning and build timestamps vary. Metadata records commit, dirty status,
actual version/build, artifact size, SHA-256, profile expiry and supplied notes.

Each run creates a mode-700 directory under
`~/Library/Application Support/PCE/iOS Releases/` with private `build.log`,
`release.json`, `permissions.json`, icon, IPA and signed app under `DerivedData`.
Failed runs retain logs there too. Nothing is uploaded. These files include
machine/signing information; do not attach them to public issues or PRs.
Old directories can be removed manually after retaining needed recovery builds.
A clean build can require several GB of free disk space.

## One-time Mac and iPhone setup

Use Node 22, Python 3, full Xcode with compatible iOS support, CocoaPods and `npm ci`.
`release.sh` prefers Homebrew's Node 22 when available. Generate the ignored
native workspace and finish Personal Team automatic Release signing using the
[existing physical-device procedure](../.agents/skills/ios-device-release/SKILL.md)
and [mobile guide](../apps/mobile/README.md). The release builder deliberately
requires the previous signed Release app in Xcode's normal build directory as
its identity baseline. If DerivedData was removed, regenerate that baseline
with the existing procedure before using this script. Do not switch teams.

Keep only reviewed public settings in ignored `apps/mobile/.env.local`:
`EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_OAUTH_CLIENT_ID` and optional
`EXPO_PUBLIC_PCE_TASKS`. They are public configuration embedded in the JS bundle,
not secret storage. Existing Tasks configuration is preserved. Unknown
`EXPO_PUBLIC_*` keys fail the build. The child build environment excludes
inherited service credentials and disables Expo dotenv loading; only approved
public settings and essential tool environment variables are passed through.
The package comes from Xcode's `.app` output, never the repository directory.
Payload checks reject dotenv/private-content/database/key files, symlinks,
source maps and common credential patterns. This is defense in depth, not a
proof that arbitrary hardcoded secrets cannot exist; review code/assets too.

On the phone: trust this Mac, enable Developer Mode, allow Xcode's preparation,
and trust the Developer App identity if requested. In Finder select the phone,
General → **Show this iPhone when on Wi-Fi** → Apply. This setting and Xcode
wireless pairing are related but distinct; verify actual discovery.

## AltStore Classic setup and current migration boundary

Install **Classic**, not PAL. Follow the [official Mac setup](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos).
Download AltServer only from the official site, verify its signature and macOS
notarization, copy to `/Applications`, and allow official updater checks. The
main download can lag the in-app updater: setup on 2026-11-05 downloaded 1.8 and
the official Sparkle feed offered 1.8.3. No Mail plug-in is needed on this Mac.

AltServer's menu-bar diamond → Install AltStore → connected unlocked iPhone.
Enter Apple ID/password/2FA directly in AltServer, never scripts or chat. Use
the same Personal Team account. **Stop at any certificate revocation prompt**:
revoking an existing identity can break the Xcode-installed app. Let the owner
review it; do not automatically revoke certificates. Allow requested local
network/notification permissions. Trust its developer profile on the phone,
open AltStore and complete its Apple sign-in directly on-device.

AltServer supports login launch. During local setup a user LaunchAgent at
`~/Library/LaunchAgents/dev.pce.altserver-login.plist` was loaded with
`RunAtLoad` and `/usr/bin/open -g /Applications/AltServer.app`; it has no
KeepAlive, secrets or PCE scheduler. Avoid enabling a duplicate login item.
Remove that agent with `launchctl bootout gui/$(id -u)
~/Library/LaunchAgents/dev.pce.altserver-login.plist` and remove its plist if
switching to AltServer's own login setting.

**Do not install the PCE IPA in AltStore over the existing app yet.** Inspected
[AltStore provisioning implementation](https://github.com/altstoreio/AltStore/blob/56854e66fef2eac32dad88dcbad1dc131d430e60/AltStore/Operations/FetchProvisioningProfilesOperation.swift#L124)
uses its own installed-app database and normally appends the team identifier
to a first-installed app's bundle ID. Its resigning operation changes the
bundle's identifier to that profile. Using the same Apple account alone does
not prove an in-place update from an Xcode installation. Experimental
randomized bundle IDs in Classic 2.3.1 further change identity; leave them off
for any migration evaluation. No identity override or certificate mutation is
implemented here. IPA packaging is supported; AltStore acceptance is a separate
device check.

PCE stores its refresh token with SecureStore
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Changing the app identifier/keychain access
can lose access to that token. A general phone/container backup is not proof
that this token can migrate to a different application identity. Note/task
content is server-backed, but that does not justify deleting the current app.

A concrete, non-destructive migration evaluation is:

1. Keep the original app installed and working. Record authenticated timeline
   and cold-relaunch behavior privately. If a backup is desired, use an
   owner-managed encrypted Finder backup and verify completion; do not assume
   it makes `THIS_DEVICE_ONLY` credentials transferable.
2. Inspect the actual proposed signed app/profile from the installed AltStore
   version. Compare bundle ID, application identifier, team, keychain groups
   and callback behavior. Never uninstall to bypass an install error.
3. If identity differs, migration requires a separately reviewed parallel-app
   plan: avoid duplicate `pce` callback registration, explicitly sign in again,
   verify backend data and session, and retain the original installation.
   That plan is not implemented or authorized by this runbook.
4. Only after an identity-preserving route is established, verify first install,
   another higher-build update, retained session and refresh before cutover.

Until those gates pass, `release.sh --install` is the practical private update
mechanism. It compares signing identity/keychain entitlements to the previous
signed local build before installation. A successful install is still not
proof of authenticated app behavior; inspect the phone after updating.

## Private source and manual transfer

Classic supports arbitrary custom sources. Source JSON must describe the
actual IPA, permissions and versions. The offline generator reads the release
metadata, verifies the IPA digest/size and creates `source.json`:

```sh
node scripts/ios/source.mjs '/private/path/to/release-directory' https://private-host.example/releases/
```

This is an **unconfigured distribution candidate**, not a working hosted feed.
It neither uploads nor starts a server. The HTTPS origin must already be
trusted and reachable by the phone without a browser-only login. Confirm the
source, icon and entire IPA download in Safari and then AltStore before
claiming access. Private GitHub release URLs need authentication that AltStore
does not automatically inherit. Public releases are prohibited. A plain HTTP
LAN server exposes private JS/native code to network observers; none is started
here. A trusted private HTTPS endpoint/VPN could be evaluated after migration
is safe. No self-signed TLS bypass or public tunnel is configured.

For a migrated/test installation only, a private AirDrop/Files transfer of the
IPA followed by AltStore My Apps → `+` is the manual fallback. It still
re-signs and can change identity. It is **not** the safe update path for the
current Xcode installation. The safe current fallback is direct device install.

## Expiry, local refresh and Remote AltServer

[Free signing](https://faq.altstore.io/altstore-classic/your-altstore) expires
after seven days and permits three active sideloaded apps including AltStore.
Apple also limits newly registered App IDs; avoid creating test IDs casually.
Rebuilding with a still-valid profile does **not** extend its expiry. The
script reports the actual expiry in private metadata and rejects expired
profiles. The direct Xcode signing path may need an occasional provisioning
refresh in Xcode's signing UI. This workflow does not claim unattended weekly
renewal for the existing Xcode-installed PCE app.

For apps actually managed by AltStore, enable Background App Refresh and local
network access, keep AltServer running and Mac awake on the same Wi-Fi, open
AltStore periodically and test **Refresh All**. iOS controls background runtime;
auto-refresh is an attempt, not a weekly guarantee. An optional personal
Shortcuts automation can run AltStore's Refresh All action; no automation is
installed here. Before expiry, verify new expiry dates for both AltStore and
its apps. AltStore cannot be assumed to refresh unrelated Xcode installations.

[Classic 2.3 introduced Remote AltServer](https://faq.altstore.io/release-notes/altstore),
with minimum iOS 17.4; 2.3.1 includes background-refresh fixes. To test:
AltStore Settings → Set up Remote AltServer → pair with the Mac → install
LocalDevVPN following the app's instructions. The owner approves the VPN
configuration on the phone. Use Wi-Fi and LocalDevVPN; cellular alone is not
supported by the [official remote instructions](https://faq.altstore.io/altstore-classic/remote-altservers).
Then disconnect from the local AltServer/Mac and perform Refresh All, verifying
changed expiry dates. Remote service availability and its handling of app and
pairing data require review before sending private artifacts. Do not upload
PCE to an unverified third-party service to demonstrate refresh.

Remote refresh capability does not build new native releases without a Mac,
and does not make a local-only source reachable remotely. Neither remote
refresh nor a week-long automatic refresh test has been verified by this repo.
If AltStore expires, reinstall AltStore from the official AltServer using the
same account **without deleting PCE**, then refresh its managed apps. If PCE's
Xcode profile expires, refresh provisioning and run the direct update command;
do not uninstall the app to fix expiry.

## Expo JavaScript-only OTA

`expo-updates`, EAS project/channel/runtime configuration and an update service
are absent. [Expo's setup](https://docs.expo.dev/eas-update/introduction/) needs
a native library, configuration and a new binary before JS/asset OTA works.
A separate issue should review private bundle hosting/access, free-tier limits,
runtime compatibility, rollback and signing. No EAS account, upload, dependency
or native migration is introduced here. OTA never renews Apple's signing profile.

## Troubleshooting and evidence boundaries

- Failed build: inspect the reported private log; do not paste raw logs publicly.
  The final validation stage can fail even after Xcode successfully compiled.
- Missing/expired profile: inspect Release Signing & Capabilities, same Personal
  Team, existing certificate and device coverage. Finish Apple authorization in
  Xcode; do not revoke identities or add provisioning flags blindly.
- Locked/unavailable phone: unlock, check trust, Developer Mode and DDI with the
  existing skill's `--check`. Do not silently fall back to a simulator.
- Install denied: retain the app; inspect the actual signature/profile and iOS
  error. Do not uninstall or change teams. Multiple phones require `--device`.
- Runtime/session: confirm the authenticated timeline, then cold relaunch;
  installation/launch command success does not verify network/authentication.

Synthetic checks: `node --test scripts/ios/release.node-test.mjs` and the existing
skill validation. Device, migration, source-download and remote-refresh results
must be reported independently with actual observations; they are not CI tests.

### Local checkpoint (2026-11-05)

- macOS 26.4.1, Xcode 26.6, iPhoneOS SDK 26.5 and an existing free Personal Team
  profile were available. The physical device reported iOS 27.0; Xcode device
  preflight passed despite the SDK/OS version difference.
- Official notarized AltServer 1.8.3 was installed and user login launch loaded.
  Finder Wi-Fi discovery was enabled and applied. Installed Classic 2.3.2 was
  confirmed through device inventory (newer than the web release-notes page).
- A first clean compile passed but packaging validation failed on `lipo`
  argument ordering; corrected. Provisioning plist dates required Python
  parsing rather than `plutil` JSON conversion; corrected.
- Two subsequent clean signed builds, IPA checks, direct updates over the
  existing app and device launch commands passed. Device inventory confirmed
  the second build number. No uninstall, team change or public upload occurred.
- Offline source generation against the actual IPA passed digest, size,
  identity, version/build and embedded-JS checks. No endpoint was configured;
  phone source download/update detection remains unverified.
- The owner reported logging into PCE and later reported LocalDevVPN installed
  and connected. Preserved pre-update session, cold-relaunch session and remote
  refresh outcomes were not yet confirmed at this checkpoint. A successful
  sign-in does not establish session preservation.
- All 13 release/helper synthetic checks, shell/JS syntax, docs links,
  targeted Prettier and repository format checks passed. Public CI results are
  reported on the PR; no device/signing credentials are available to CI.

The workspace suite initially picked up the Node helper as a Vitest suite; the
helper was renamed to `release.node-test.mjs`. After that correction, local
`npm test` passed: 77 suites / 354 tests; 22 integration suites / 128 tests
were skipped by their existing environment gates. This is not DB/device E2E
evidence. The owner subsequently reported Remote AltServer setup completed;
refresh itself still requires a phone-side result.
