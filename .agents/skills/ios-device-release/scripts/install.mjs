#!/usr/bin/env node
// Local-only, interactive physical-iPhone Release installer. No credentials are logged.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const mobile = path.join(root, "apps/mobile");
const bundleId = "dev.pce.mobile";

function fail(message) {
  throw new Error(message);
}

export function parseArgs(args) {
  let device;
  let checkOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") {
      checkOnly = true;
    } else if (args[i] === "--device" && args[i + 1] && !args[i + 1].startsWith("--")) {
      if (device) fail("Specify --device only once.");
      device = args[++i];
    } else {
      fail("Usage: node .agents/skills/ios-device-release/scripts/install.mjs [--check] [--device DEVICE_ID]");
    }
  }
  return { device, checkOnly };
}

export function parseDotEnv(input) {
  const values = {};
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(EXPO_PUBLIC_API_BASE_URL|EXPO_PUBLIC_OAUTH_CLIENT_ID)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

export function validatePublicConfig(config) {
  const api = config.EXPO_PUBLIC_API_BASE_URL;
  const clientId = config.EXPO_PUBLIC_OAUTH_CLIENT_ID;
  if (!api || !clientId) {
    fail("Missing public iOS OAuth settings. Set EXPO_PUBLIC_API_BASE_URL and EXPO_PUBLIC_OAUTH_CLIENT_ID in apps/mobile/.env.local or the environment.");
  }
  let url;
  try {
    url = new URL(api);
  } catch {
    fail("EXPO_PUBLIC_API_BASE_URL must be an HTTPS API origin.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || /^(localhost|127\.|0\.0\.0\.0$)/i.test(url.hostname)) {
    fail("EXPO_PUBLIC_API_BASE_URL must be a reachable HTTPS origin without credentials, path, query or fragment.");
  }
  if (/\s/.test(clientId)) {
    fail("EXPO_PUBLIC_OAUTH_CLIENT_ID must be a nonempty public client identifier (no whitespace).");
  }
  return true;
}

export function parseConnectedIphones(raw) {
  let devices;
  try {
    devices = JSON.parse(raw);
  } catch {
    fail("Could not parse Xcode device inventory (xcdevice JSON).");
  }
  if (!Array.isArray(devices)) fail("Unexpected xcdevice inventory format.");
  return devices
    .filter((item) => item && item.simulator === false && item.available === true &&
      (item.platform === "com.apple.platform.iphoneos" || item.platform === "iOS") &&
      [item.modelCode, item.modelName, item.name].some((value) =>
        typeof value === "string" && /iphone/i.test(value)))
    .map((item) => ({ id: item.identifier, name: item.name }))
    .filter((item) => typeof item.id === "string" && item.id.length > 0);
}

export function selectIphone(devices, requested) {
  if (requested) {
    const match = devices.find((device) => device.id === requested);
    if (!match) fail("Requested --device ID is not an available physical iPhone. Connect, unlock, trust the Mac and enable Developer Mode.");
    return match;
  }
  if (devices.length === 0) fail("No available physical iPhone. Connect and unlock the phone, trust the Mac, enable Developer Mode, and retry.");
  if (devices.length > 1) {
    fail("Multiple iPhones detected; pass --device DEVICE_ID. Available devices: " +
      devices.map((device) => device.name + " (" + device.id + ")").join(", "));
  }
  return devices[0];
}

export function releaseArgs(deviceId) {
  return ["run", "ios", "-w", "@pce/mobile", "--", "--device", deviceId, "--configuration", "Release"];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) fail("Cannot run " + command + ": " + result.error.message);
  if (result.status !== 0) fail(command + " failed with exit code " + result.status + ".");
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    fail(command + " preflight failed. Check full Xcode installation, active developer directory and first-run license.");
  }
  return result.stdout.trim();
}

export function runInstall(args = process.argv.slice(2)) {
  const { device, checkOnly } = parseArgs(args);
  if (process.platform !== "darwin") fail("Physical iPhone signing/install requires a local Mac with full Xcode.");
  if (Number(process.versions.node.split(".")[0]) < 22) fail("Node.js 22+ is required; use the repository .nvmrc.");
  if (/^(NO|0|false)$/i.test(process.env.CODE_SIGNING_ALLOWED ?? "")) {
    fail("CODE_SIGNING_ALLOWED must not disable signing: OAuth refresh requires iOS Keychain entitlements.");
  }
  const developerDir = capture("xcode-select", ["-p"]);
  if (!existsSync(path.join(developerDir, "Platforms/iPhoneOS.platform"))) {
    fail("Select full Xcode (not Command Line Tools) using xcode-select.");
  }
  capture("xcodebuild", ["-version"]);
  capture("pod", ["--version"]);
  capture("npm", ["--version"]);
  if (!existsSync(path.join(root, "node_modules"))) fail("Missing node_modules. Run npm ci from the repository root first.");

  const envFile = path.join(mobile, ".env.local");
  const local = existsSync(envFile) ? parseDotEnv(readFileSync(envFile, "utf8")) : {};
  validatePublicConfig({
    EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL ?? local.EXPO_PUBLIC_API_BASE_URL,
    EXPO_PUBLIC_OAUTH_CLIENT_ID: process.env.EXPO_PUBLIC_OAUTH_CLIENT_ID ?? local.EXPO_PUBLIC_OAUTH_CLIENT_ID,
  });

  const app = JSON.parse(readFileSync(path.join(mobile, "app.json"), "utf8")).expo;
  if (app.ios?.bundleIdentifier !== bundleId || app.scheme !== "pce") {
    fail("Unexpected iOS bundle identifier or OAuth URL scheme. Review existing install identity before deploying.");
  }
  const iphone = selectIphone(parseConnectedIphones(capture("xcrun", ["xcdevice", "list", "--json"])), device);
  console.log("[ios-device-release] Device: " + iphone.name + " (" + iphone.id + "); configuration: Release.");
  console.log("[ios-device-release] Public OAuth settings and Xcode toolchain: OK (values hidden).");
  if (checkOnly) {
    console.log("[ios-device-release] Preflight passed; no build or installation performed.");
    return;
  }
  console.log("[ios-device-release] Preparing shared packages...");
  run("npm", ["run", "dev:prepare"]);
  console.log("[ios-device-release] Expo will build, sign, install and launch in one operation (no Metro in Release).");
  try {
    run("npm", releaseArgs(iphone.id));
  } catch (error) {
    fail("Expo combined build/install/launch operation failed. Inspect the Xcode/Expo output above to identify the failing phase. " +
      "For first-time or expired free signing, open apps/mobile/ios/*.xcworkspace in Xcode and select your Personal Team under Signing & Capabilities. " +
      error.message);
  }
  console.log("[ios-device-release] Expo command succeeded. Verify the app opens and OAuth works on the phone; no device UI inspection was performed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runInstall();
  } catch (error) {
    console.error("[ios-device-release] " + error.message);
    process.exitCode = 1;
  }
}
