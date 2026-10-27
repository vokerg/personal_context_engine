// Run explicitly with: node --test .agents/skills/ios-device-release/scripts/validate.mjs
// Kept out of Vitest discovery; uses only the built-in Node.js test runner.
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArgs,
  parseDotEnv,
  parseConnectedIphones,
  releaseArgs,
  selectIphone,
  validatePublicConfig,
  validateDeviceReadiness,
  validateSigningIdentities,
} from "./install.mjs";

const validConfig = {
  EXPO_PUBLIC_API_BASE_URL: "https://api.example.com",
  EXPO_PUBLIC_OAUTH_CLIENT_ID: "pce-ios",
};
const iphone = {
  identifier: "00008120-iPhone",
  name: "My iPhone",
  simulator: false,
  available: true,
  platform: "com.apple.platform.iphoneos",
};
const simulator = {
  identifier: "simulator-id",
  name: "iPhone Simulator",
  simulator: true,
  available: true,
  platform: "com.apple.platform.iphonesimulator",
};

test("flags accept only --check and an explicit device identifier", () => {
  assert.deepEqual(parseArgs([]), { device: undefined, checkOnly: false });
  assert.deepEqual(parseArgs(["--check", "--device", iphone.identifier]), {
    device: iphone.identifier,
    checkOnly: true,
  });
  assert.throws(() => parseArgs(["--configuration", "Debug"]), /Usage/);
  assert.throws(() => parseArgs(["--device"]), /Usage/);
  assert.throws(
    () => parseArgs(["--device", "a", "--device", "b"]),
    /only once/,
  );
});

test("dotenv extraction reads only public keys and never evaluates shell expressions", () => {
  const parsed = parseDotEnv(
    '# comment\nEXPO_PUBLIC_API_BASE_URL="https://api.example.com"\nexport EXPO_PUBLIC_OAUTH_CLIENT_ID=pce-ios # comment\nSECRET_TOKEN=$(unsafe)\n',
  );
  assert.deepEqual(parsed, validConfig);
});

test("public OAuth configuration must be an HTTPS origin and a nonempty client ID", () => {
  assert.equal(validatePublicConfig(validConfig), true);
  for (const url of [
    "http://api.example.com",
    "https://localhost:3000",
    "https://app.localhost",
    "https://[::1]",
    "https://127.0.0.1",
    "https://a.example.com/private",
    "https://name:pass@a.example.com",
    "https://a.example.com?debug=yes",
    "invalid",
  ]) {
    assert.throws(
      () =>
        validatePublicConfig({ ...validConfig, EXPO_PUBLIC_API_BASE_URL: url }),
      /HTTPS/,
    );
  }
  assert.throws(
    () =>
      validatePublicConfig({ ...validConfig, EXPO_PUBLIC_OAUTH_CLIENT_ID: "" }),
    /Missing/,
  );
  assert.throws(
    () =>
      validatePublicConfig({
        ...validConfig,
        EXPO_PUBLIC_OAUTH_CLIENT_ID: "has space",
      }),
    /whitespace/,
  );
});

test("device inventory excludes simulator, unavailable device and non-iPhone platform", () => {
  assert.deepEqual(
    parseConnectedIphones(
      JSON.stringify([
        iphone,
        simulator,
        { ...iphone, available: false, identifier: "locked" },
        { ...iphone, platform: "com.apple.platform.macos", identifier: "mac" },
        {
          ...iphone,
          identifier: "ipad",
          name: "My iPhone",
          modelCode: "iPad16,5",
        },
      ]),
    ),
    [{ id: iphone.identifier, name: iphone.name }],
  );
  assert.throws(() => parseConnectedIphones("not JSON"), /parse/);
  assert.throws(() => parseConnectedIphones("{}"), /format/);
});

test("hardware model identifies a renamed iPhone", () => {
  assert.deepEqual(
    parseConnectedIphones(
      JSON.stringify([
        { ...iphone, name: "Personal device", modelCode: "iPhone17,2" },
      ]),
    ),
    [{ id: iphone.identifier, name: "Personal device" }],
  );
});

test("available xcdevice entry does not prove Developer Mode or DDI readiness", () => {
  const details = (properties) =>
    JSON.stringify({ result: { deviceProperties: properties } });
  assert.doesNotThrow(() =>
    validateDeviceReadiness(
      details({ developerModeStatus: "enabled", ddiServicesAvailable: true }),
    ),
  );
  assert.throws(
    () =>
      validateDeviceReadiness(
        details({
          developerModeStatus: "disabled",
          ddiServicesAvailable: false,
        }),
      ),
    /Developer Mode is disabled/,
  );
  assert.throws(
    () =>
      validateDeviceReadiness(
        details({
          developerModeStatus: "enabled",
          ddiServicesAvailable: false,
        }),
      ),
    /DDI/,
  );
  assert.throws(() => validateDeviceReadiness("{}"), /Cannot verify/);
  assert.throws(() => validateDeviceReadiness("not JSON"), /parse/);
});

test("preflight refuses absent signing identities without echoing certificate data", () => {
  assert.doesNotThrow(() =>
    validateSigningIdentities(
      '1) FAKE "Apple Development: Synthetic"\n  1 valid identities found',
    ),
  );
  assert.throws(
    () => validateSigningIdentities("  0 valid identities found"),
    /No valid code signing identity/,
  );
  assert.throws(
    () => validateSigningIdentities("unrecognized output"),
    /No valid code signing identity/,
  );
});

test("device selection refuses no device, multiple devices, or wrong requested ID", () => {
  const first = { id: iphone.identifier, name: iphone.name };
  const second = { id: "second", name: "Second iPhone" };
  assert.deepEqual(selectIphone([first]), first);
  assert.deepEqual(selectIphone([first, second], "second"), second);
  assert.throws(() => selectIphone([]), /No available/);
  assert.throws(() => selectIphone([first, second]), /Multiple/);
  assert.throws(() => selectIphone([first], "simulator-id"), /physical iPhone/);
});

test("Release command cannot silently target a simulator or Debug configuration", () => {
  assert.deepEqual(releaseArgs(iphone.identifier), [
    "run",
    "ios",
    "-w",
    "@pce/mobile",
    "--",
    "--device",
    iphone.identifier,
    "--configuration",
    "Release",
  ]);
});
