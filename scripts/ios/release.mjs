#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  readdirSync,
  lstatSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import {
  validatePublicConfig,
  parseConnectedIphones,
  selectIphone,
  validateDeviceReadiness,
} from "../../.agents/skills/ios-device-release/scripts/install.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const mobile = path.join(root, "apps/mobile");
const id = "dev.pce.mobile";
const scheme = "PersonalContextEngine";
function requireThat(ok, message) {
  if (!ok) throw new Error(message);
}
export function parseArgs(args) {
  const options = { install: false, altstore: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--install") options.install = true;
    else if (arg === "--altstore") options.altstore = true;
    else if (["--build", "--version", "--device", "--notes"].includes(arg)) {
      requireThat(
        args[i + 1] && !args[i + 1].startsWith("--") && !options[arg.slice(2)],
        `Missing or repeated ${arg}`,
      );
      options[arg.slice(2)] = args[++i];
    } else
      throw new Error(
        "Usage: release.sh [--install | --altstore] [--device ID] [--version X.Y.Z] [--build N] [--notes FILE]",
      );
  }
  requireThat(
    !options.install || !options.altstore,
    "AltStore candidates must be imported by AltStore; do not direct-install them",
  );
  if (options.version)
    requireThat(
      /^\d+\.\d+\.\d+$/.test(options.version),
      "Version must be X.Y.Z",
    );
  if (options.build)
    requireThat(
      /^[1-9]\d{0,12}$/.test(options.build),
      "Build must be a positive integer (at most 13 digits)",
    );
  return options;
}
export function publicEnvironment(local, inherited) {
  const allowed = [
    "EXPO_PUBLIC_API_BASE_URL",
    "EXPO_PUBLIC_OAUTH_CLIENT_ID",
    "EXPO_PUBLIC_PCE_TASKS",
  ];
  for (const key of new Set([
    ...Object.keys(local),
    ...Object.keys(inherited),
  ])) {
    requireThat(
      !key.startsWith("EXPO_PUBLIC_") || allowed.includes(key),
      `Unreviewed public environment key: ${key}`,
    );
  }
  const env = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "DEVELOPER_DIR",
    "LANG",
  ])
    if (inherited[key]) env[key] = inherited[key];
  for (const key of allowed)
    if (inherited[key] ?? local[key]) env[key] = inherited[key] ?? local[key];
  validatePublicConfig(env);
  requireThat(
    !env.EXPO_PUBLIC_PCE_TASKS ||
      ["true", "false"].includes(env.EXPO_PUBLIC_PCE_TASKS),
    "Tasks flag must be true or false",
  );
  return {
    ...env,
    NODE_ENV: "production",
    EXPO_NO_DOTENV: "1",
    CI: "1",
    NODE_BINARY: process.execPath,
    RCT_NO_LAUNCH_PACKAGER: "1",
  };
}
export function auditFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    requireThat(
      !lstatSync(target).isSymbolicLink(),
      "Unexpected symlink in app payload",
    );
    requireThat(
      !/^(\.env(?:\..*)?|\.git|node_modules|inbox|notes|research|.*\.(?:pem|p12|key|sqlite|sqlite3|db|map|xcarchive))$/i.test(
        entry.name,
      ),
      "Unexpected private/development file in app payload",
    );
    if (entry.isDirectory()) auditFiles(target);
  }
}

export function runRelease(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  requireThat(process.platform === "darwin", "Release requires a local Mac");
  requireThat(
    process.versions.node.split(".")[0] === "22",
    "Use Node 22 (see .nvmrc)",
  );
  process.umask(0o077);
  const base = path.join(
    homedir(),
    "Library/Application Support/PCE/iOS Releases",
  );
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const out = mkdtempSync(path.join(base, "release-"));
  const log = path.join(out, "build.log");
  const localFile = path.join(mobile, ".env.local");
  const env = publicEnvironment(
    existsSync(localFile) ? parseEnv(readFileSync(localFile, "utf8")) : {},
    process.env,
  );
  const fd = openSync(log, "a", 0o600);
  function run(command, argv, capture = false) {
    const result = spawnSync(command, argv, {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: capture ? ["ignore", "pipe", fd] : ["ignore", fd, fd],
    });
    requireThat(
      !result.error && result.status === 0,
      `${command} failed; inspect private log: ${log}`,
    );
    return result.stdout?.trim();
  }
  function jsonPlist(file) {
    return JSON.parse(
      run("plutil", ["-convert", "json", "-o", "-", file], true),
    );
  }
  function signature(app, name) {
    const file = path.join(out, name + ".plist");
    const r = spawnSync("codesign", ["-d", "--entitlements", ":-", app], {
      env,
      encoding: "utf8",
    });
    requireThat(
      r.status === 0 && r.stdout.includes("<plist"),
      "Cannot read signed app entitlements",
    );
    writeFileSync(file, r.stdout, { mode: 0o600 });
    return jsonPlist(file);
  }
  try {
    console.log("[ios-release] Private output:", out);
    for (const [cmd, argv] of [
      ["xcodebuild", ["-version"]],
      ["pod", ["--version"]],
      ["npm", ["--version"]],
      ["python3", ["--version"]],
    ])
      run(cmd, argv);
    requireThat(
      existsSync(path.join(root, "node_modules")),
      "Run npm ci first",
    );
    const workspace = path.join(mobile, "ios", scheme + ".xcworkspace");
    requireThat(
      existsSync(workspace),
      "Generate native project and configure Personal Team using the iPhone Release runbook first",
    );
    const appConfig = JSON.parse(
      readFileSync(path.join(mobile, "app.json"), "utf8"),
    ).expo;
    requireThat(
      appConfig.ios.bundleIdentifier === id && appConfig.scheme === "pce",
      "App identity/callback changed",
    );
    const settings = JSON.parse(
      run(
        "xcodebuild",
        [
          "-workspace",
          workspace,
          "-scheme",
          scheme,
          "-configuration",
          "Release",
          "-sdk",
          "iphoneos",
          "-showBuildSettings",
          "-json",
        ],
        true,
      ),
    ).find((x) => x.target === scheme)?.buildSettings;
    requireThat(
      settings?.PRODUCT_BUNDLE_IDENTIFIER === id && settings.DEVELOPMENT_TEAM,
      "Configure existing Personal Team in Release target",
    );
    const previous = path.join(
      settings.TARGET_BUILD_DIR,
      settings.FULL_PRODUCT_NAME,
    );
    requireThat(
      existsSync(previous),
      "Existing signed Release app is required as the identity baseline; use the existing device skill first",
    );
    run("codesign", ["--verify", "--deep", "--strict", previous]);
    const baseline = signature(previous, "baseline-entitlements");
    requireThat(
      baseline["application-identifier"]?.endsWith("." + id) &&
        baseline["com.apple.developer.team-identifier"] ===
          settings.DEVELOPMENT_TEAM,
      "Baseline app does not match the configured signing team/identity",
    );
    const prior = jsonPlist(path.join(previous, "Info.plist"));
    let lastBuild = Number(prior.CFBundleVersion);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const record = path.join(base, entry.name, "release.json");
      if (entry.isDirectory() && existsSync(record)) {
        const release = JSON.parse(readFileSync(record, "utf8"));
        requireThat(
          release.bundleIdentifier === id && /^\d+$/.test(release.build),
          "Invalid local release history",
        );
        lastBuild = Math.max(lastBuild, Number(release.build));
      }
    }
    const version = options.version ?? appConfig.version;
    requireThat(/^\d+\.\d+\.\d+$/.test(version), "Invalid app version");
    const build =
      options.build ??
      String(Math.max(Math.floor(Date.now() / 1000), lastBuild + 1));
    requireThat(
      Number(build) > lastBuild,
      "Build must exceed previous local release builds",
    );
    // Supply a copy of the native Info.plist to Xcode; never edit or re-sign a built bundle.
    const info = path.join(out, "Input-Info.plist");
    cpSync(path.join(mobile, "ios", scheme, "Info.plist"), info);
    run("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :CFBundleShortVersionString ${version}`,
      info,
    ]);
    run("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :CFBundleVersion ${build}`,
      info,
    ]);
    if (options.altstore)
      run("/usr/libexec/PlistBuddy", [
        "-c",
        "Set :CFBundleDisplayName PCE AltStore",
        info,
      ]);
    let device;
    if (options.install) {
      device = selectIphone(
        parseConnectedIphones(
          run("xcrun", ["xcdevice", "list", "--json"], true),
        ),
        options.device,
      );
      const details = path.join(out, "device.json");
      run("xcrun", [
        "devicectl",
        "device",
        "info",
        "details",
        "--device",
        device.id,
        "--json-output",
        details,
      ]);
      validateDeviceReadiness(readFileSync(details, "utf8"));
      rmSync(details);
    }
    for (const pkg of ["@pce/core", "@pce/contracts", "@pce/api-client"])
      run("npm", ["run", "build", "-w", pkg]);
    console.log(
      "[ios-release] Building clean signed iphoneos Release; output is in the private log.",
    );
    const derived = path.join(out, "DerivedData");
    run("xcodebuild", [
      "-workspace",
      workspace,
      "-scheme",
      scheme,
      "-configuration",
      "Release",
      "-sdk",
      "iphoneos",
      "-destination",
      "generic/platform=iOS",
      "-derivedDataPath",
      derived,
      `INFOPLIST_FILE=${info}`,
      `MARKETING_VERSION=${version}`,
      `CURRENT_PROJECT_VERSION=${build}`,
      "build",
    ]);
    const app = path.join(
      derived,
      "Build/Products/Release-iphoneos",
      scheme + ".app",
    );
    run("codesign", ["--verify", "--deep", "--strict", app]);
    const actual = jsonPlist(path.join(app, "Info.plist"));
    requireThat(
      !options.altstore || actual.CFBundleDisplayName === "PCE AltStore",
      "AltStore candidate label missing",
    );
    requireThat(
      actual.CFBundleIdentifier === id &&
        actual.CFBundleShortVersionString === version &&
        actual.CFBundleVersion === build,
      "Built IPA identity/version mismatch",
    );
    requireThat(
      actual.CFBundleSupportedPlatforms?.includes("iPhoneOS") &&
        actual.CFBundleURLTypes?.some((x) =>
          x.CFBundleURLSchemes?.includes("pce"),
        ),
      "Not an iPhone app or callback missing",
    );
    requireThat(
      existsSync(path.join(app, "main.jsbundle")) &&
        lstatSync(path.join(app, "main.jsbundle")).size > 1000,
      "Embedded JavaScript bundle missing",
    );
    run("lipo", [
      path.join(app, actual.CFBundleExecutable),
      "-verify_arch",
      "arm64",
    ]);
    const signed = signature(app, "release-entitlements");
    for (const key of [
      "application-identifier",
      "com.apple.developer.team-identifier",
      "keychain-access-groups",
    ])
      requireThat(
        JSON.stringify(signed[key]) === JSON.stringify(baseline[key]),
        `Signing identity changed (${key}); installation blocked`,
      );
    const profile = path.join(out, "profile.plist");
    writeFileSync(
      profile,
      run(
        "security",
        ["cms", "-D", "-i", path.join(app, "embedded.mobileprovision")],
        true,
      ),
    );
    const provision = JSON.parse(
      run(
        "python3",
        [
          "-c",
          "import plistlib,json,sys; p=plistlib.load(open(sys.argv[1],'rb')); print(json.dumps({'ExpirationDate':p['ExpirationDate'].isoformat()+'Z','Entitlements':p['Entitlements'],'ProvisionedDevices':p.get('ProvisionedDevices',[])}))",
          profile,
        ],
        true,
      ),
    );
    requireThat(
      new Date(provision.ExpirationDate) > new Date(),
      "Provisioning profile expired; refresh in Xcode signing UI",
    );
    requireThat(
      provision.Entitlements?.["application-identifier"] ===
        signed["application-identifier"],
      "Profile/app identity mismatch",
    );
    writeFileSync(
      path.join(out, "permissions.json"),
      JSON.stringify(
        {
          entitlements: Object.keys(signed).sort(),
          privacy: Object.fromEntries(
            Object.entries(actual).filter(([key]) =>
              key.endsWith("UsageDescription"),
            ),
          ),
        },
        null,
        2,
      ) + "\n",
    );
    auditFiles(app);
    // Reject obvious credential material in payloads; public build flags are intentionally embedded.
    function scan(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else {
          const b = readFileSync(p);
          requireThat(
            !/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|sk-proj-[A-Za-z0-9_-]{30,})/.test(
              b.toString("latin1"),
            ),
            "Credential pattern found in payload",
          );
        }
      }
    }
    scan(app);
    const payload = path.join(out, "package/Payload");
    mkdirSync(payload, { recursive: true });
    cpSync(app, path.join(payload, scheme + ".app"), { recursive: true });
    const ipa = path.join(out, `PCE-${version}-${build}.ipa`);
    run("ditto", ["-c", "-k", "--keepParent", payload, ipa]);
    run("unzip", ["-t", ipa]);
    const metadata = {
      schemaVersion: 1,
      bundleIdentifier: id,
      displayName: actual.CFBundleDisplayName,
      version,
      build,
      builtAt: new Date().toISOString(),
      commit: run("git", ["rev-parse", "HEAD"], true),
      dirty: Boolean(run("git", ["status", "--porcelain"], true)),
      sha256: createHash("sha256").update(readFileSync(ipa)).digest("hex"),
      size: lstatSync(ipa).size,
      ipa: path.basename(ipa),
      minimumOSVersion: actual.MinimumOSVersion,
      profileExpiresAt: provision.ExpirationDate,
      notes: options.notes
        ? readFileSync(path.resolve(options.notes), "utf8")
        : "Local personal Release build.",
      altStoreMigrationVerified: false,
      distribution: options.altstore
        ? "altstore-parallel-candidate"
        : "direct-device",
    };
    cpSync(path.join(mobile, "assets/icon.png"), path.join(out, "icon.png"));
    writeFileSync(
      path.join(out, "release.json"),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    if (options.install) {
      console.log(
        "[ios-release] Installing with existing app/keychain identity (no uninstall).",
      );
      run("xcrun", [
        "devicectl",
        "device",
        "install",
        "app",
        "--device",
        device.id,
        app,
      ]);
      run("xcrun", [
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        device.id,
        id,
      ]);
      console.log(
        "[ios-release] Device installation and launch commands passed; verify authenticated UI/session on the phone.",
      );
    }
    console.log("[ios-release] Validated signed IPA:", ipa);
    console.log(
      options.altstore
        ? "[ios-release] Import this PCE AltStore candidate through AltStore while retaining the original app. Verify the managed identifier and sign in to the new copy. No migration is claimed."
        : "[ios-release] AltStore migration is unverified; do not install this over PCE using AltStore.",
    );
    return out;
  } finally {
    closeSync(fd);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runRelease();
  } catch (error) {
    console.error("[ios-release]", error.message);
    process.exitCode = 1;
  }
}
