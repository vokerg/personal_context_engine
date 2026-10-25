---
name: ios-device-release
description: Build, locally sign, install and launch the Personal Context Engine Expo iOS app as a standalone Release build on a connected physical iPhone from a Mac. Use for on-demand iPhone deployment or renewing free Personal Team signing; not for simulators, Expo Go, EAS, TestFlight or App Store submissions.
---

# iPhone Release deployment (local Mac only)

This skill is a reproducible local device workflow, **not** an instruction to modify app/server code. Read [apps/mobile/README.md](../../../apps/mobile/README.md) before troubleshooting native auth or signing.

## Procedure

1. Check the local checkout and `git status --short`. Build the code currently checked out; do not pull, switch branches, discard changes or commit generated files without an explicit request.
2. Use Node 22 (see `.nvmrc`). Ensure the existing `apps/mobile/.env.local` has `EXPO_PUBLIC_API_BASE_URL` set to the deployed HTTPS API origin and `EXPO_PUBLIC_OAUTH_CLIENT_ID` set to the registered public native OAuth client. **Never expose their values in transcripts or logs.** Never put secrets or tokens in Expo public env.
3. Connect and unlock the iPhone, trust this Mac, enable Developer Mode on the phone, and make sure full Xcode is selected. Sign into Xcode with an Apple ID. For a free account, select **Personal Team** under Signing & Capabilities with automatic signing for the `dev.pce.mobile` target; first-time profile/device registration is interactive and requires the owner's confirmation.
4. From the repository root, run the safe preflight:

~~~sh
node .agents/skills/ios-device-release/scripts/install.mjs --check
~~~

5. If preflight passes, build and install the embedded-JS Release app (no Metro):

~~~sh
node .agents/skills/ios-device-release/scripts/install.mjs
~~~

If multiple iPhones are connected, pass `--device DEVICE_ID` to both commands. Use the exact identifier reported by the preflight. The helper prepares shared workspaces and invokes Expo's supported `expo run:ios --configuration Release --device DEVICE_ID` through the repo npm workspace; Expo owns Xcode build, installation and launch. The helper only reports the success/failure of that **combined operation**; do not claim independently verified install, boot or sign-in.

6. Ask the owner to confirm the app launches without Metro, OAuth returns to `pce://oauth/callback`, and signed-in session survives a cold relaunch. Report what the tool actually established and which device checks remain manual.

## Troubleshooting and guardrails

- Initial or expired free provisioning: Expo may create the ignored `apps/mobile/ios/` tree before signing fails. Open the generated `*.xcworkspace` in Xcode; set target > Signing & Capabilities > Automatically manage signing > Personal Team for the appropriate configuration, then retry the helper. Xcode may ask to create/manage a certificate/profile: the owner must explicitly authorize this via Apple's UI. Free provisioning usually expires after 7 days; repeat install/re-sign. No $99 Apple Developer membership is required for this local route.
- An iPhone missing from the inventory may be unplugged, locked, untrusted, not paired, or unavailable under Developer Mode. Never fall back to an iOS simulator.
- Do not set `CODE_SIGNING_ALLOWED=NO`: the app uses SecureStore/Keychain and cannot authenticate correctly without the signing entitlements (observed in #131).
- Preserve `dev.pce.mobile`, `pce://oauth/callback`, user data and installed app identity. Do not uninstall, clear app data, change provisioning teams, override signing settings, or regenerate native folders with `--clean` without explicit consent.
- No Expo Go, EAS Build, TestFlight, paid distribution, unattended provisioning, `sudo`, or changes to hosted OAuth registration. Never copy personal notes or credentials into the public code repository.
- The checked-in `apps/mobile/ios/` path is gitignored; do not commit generated workspace, machine profiles, private artifacts or logs.
- For non-device validation: `node --test .agents/skills/ios-device-release/scripts/validate.mjs`. It runs without Xcode and is not proof of any successful real-device build.

When failing, state the exact failed **stage** when it is known (preflight, shared-package preparation, or Expo's combined build/install/launch), plus minimal safe recovery steps. Distinguish tool success from user-observed runtime behavior.