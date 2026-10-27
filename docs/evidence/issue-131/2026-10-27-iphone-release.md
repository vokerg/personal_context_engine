# Physical iPhone Release checkpoint — 2026-10-27

Refs #131; installer skill delivered in PR #144 / #141. The owner requested
installation on the attached phone. This checkpoint does not close the broader
App v1 acceptance issue or authorize TestFlight, push delivery or content writes.

## Environment and source

- App source: `6a3d111` (main after #144); this follow-up changes only the installer
  command/test and documentation, not application behavior.
- Local Apple Silicon Mac, Xcode 26.6 (`17F113`).
- Physical iPhone 16 Pro Max, iOS 27.0 (`24A437`), paired over USB.
- Expo 54.0.37, React Native 0.81.5, Node 22.23.3, CocoaPods 1.17.0.
- Configuration: locally signed **Release**, `dev.pce.mobile`, existing
  `pce://oauth/callback`, existing hosted HTTPS OAuth settings and public feature
  flags. No hosted registration or scope change.

## First-time setup and recovery observed

The simulator's PCE login did not supply the Apple Account or signing identity
needed for the physical phone. The owner enabled Developer Mode, restarted and
confirmed it on the phone, signed into Xcode, created an Apple Development
certificate and selected the free Personal Team for all target configurations.
Xcode then created the managed app/device provisioning profile.

After certificate creation, Xcode showed the identity but `security` still
reported zero valid code-signing identities. Its issuer required WWDR G3; the
only locally installed WWDR intermediate was the older certificate that expired
in 2023. The matching G3 intermediate was downloaded from
[Apple PKI](https://www.apple.com/certificateauthority/), verified against normal
system trust and imported into the user's login keychain with default trust.
The valid identity count became one. No root certificates, trust overrides,
certificate revocation, private-key exports or disabled signing were involved.
See [Apple's recovery guidance](https://help.apple.com/xcode/mac/current/en.lproj/devc4c7101d8.html).

The guarded helper now passes the actual Developer Mode/DDI and identity checks.
The native team/profile configuration remains in ignored `apps/mobile/ios/`;
no personal Team ID was added to tracked Expo configuration.

## Installation command and results

From the repository root, with Node 22 available:

```sh
node .agents/skills/ios-device-release/scripts/install.mjs --check
node .agents/skills/ios-device-release/scripts/install.mjs
```

Initial native Release compilation and signing passed with zero errors and
zero warnings. Installation completed and a separate `devicectl` app inventory
confirmed `dev.pce.mobile`, version `0.1.0`, build `1` on the physical phone.
The first launch was denied by iOS with the signature/entitlements/untrusted-profile
message; the owner was directed to Settings > General > VPN & Device Management
to trust their Developer App identity. Expo's combined command therefore exited
with failure despite a successful build and installation.

Local artifact checks passed: embedded `main.jsbundle` present, strict/deep code
signature verification successful, and signed application identifier matches
`dev.pce.mobile`. The managed profile includes one physical device and expires
on **2026-11-03 UTC**. No claim of runtime SecureStore/OAuth success follows from
these artifact checks alone.

The initial invocation also revealed that this Expo CLI starts Metro by default
even with Release. The helper now adds its supported `--no-bundler` flag, covered
by the command assertion. The incidental Metro-generated `tsconfig.json` rewrite
was restored; native/generated configuration is excluded from the PR. Repeat
installation and launch with no Metro are pending verification after device trust.

After the device trust step, a direct `devicectl device process launch` succeeded
for `dev.pce.mobile`. There was no listener on Metro port 8081. This verifies
installation and native launch of the embedded Release artifact without Metro;
the updated helper's complete `--no-bundler` build/install/launch invocation has
not yet been repeated. The supported CLI option was verified against the locally
installed Expo CLI's help, and all nine helper tests passed with Node 22.

`npm run docs:check` and `git diff --check` passed. The broader application
workspace checks are delegated to synthetic PR CI; local personal configuration
and raw device artifacts are not used in public CI.

## Remaining product acceptance

Physical-phone OAuth/callback, secure session restoration after cold relaunch,
cellular/Wi-Fi behavior, accessibility, detailed screen QA, capture/removal and
notification checks remain pending unless separately observed. No personal
content was created or changed as a deployment test. Raw build logs, screenshots,
device/account identifiers, certificates, profiles and credentials remain local.
