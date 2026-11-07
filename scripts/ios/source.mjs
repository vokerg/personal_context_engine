#!/usr/bin/env node
// Offline source generation only. Does not upload, serve, sign, or install anything.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
export function makeSource(metadata, base, permissions) {
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use a trusted HTTPS base URL without credentials/query/fragment",
    );
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  if (
    metadata.bundleIdentifier !== "dev.pce.mobile" ||
    !/^[\w.-]+\.ipa$/.test(metadata.ipa)
  )
    throw new Error("Unexpected IPA identity or filename");
  const resource = (name) => new URL(name, url).href;
  return {
    name: "PCE Personal Releases",
    apps: [
      {
        name: metadata.displayName ?? "Personal Context Engine",
        bundleIdentifier: metadata.bundleIdentifier,
        developerName: "Personal local build",
        localizedDescription:
          "Personal Context Engine. Identity migration must be verified before installing through AltStore.",
        iconURL: resource("icon.png"),
        versions: [
          {
            version: metadata.version,
            buildVersion: metadata.build,
            date: metadata.builtAt,
            localizedDescription: metadata.notes,
            downloadURL: resource(metadata.ipa),
            size: metadata.size,
            sha256: metadata.sha256,
            minOSVersion: metadata.minimumOSVersion,
          },
        ],
        appPermissions: permissions,
      },
    ],
    news: [],
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [directory, base, ...extra] = process.argv.slice(2);
    if (!directory || !base || extra.length)
      throw new Error(
        "Usage: node scripts/ios/source.mjs RELEASE_DIRECTORY TRUSTED_HTTPS_BASE_URL",
      );
    const metadata = JSON.parse(
      readFileSync(path.join(directory, "release.json"), "utf8"),
    );
    makeSource(metadata, base, {}); // Validate filename/identity before reading any IPA.
    const ipa = readFileSync(path.join(directory, metadata.ipa));
    if (
      ipa.length !== metadata.size ||
      createHash("sha256").update(ipa).digest("hex") !== metadata.sha256
    )
      throw new Error("IPA does not match release metadata");
    const permissions = JSON.parse(
      readFileSync(path.join(directory, "permissions.json"), "utf8"),
    );
    process.umask(0o077);
    writeFileSync(
      path.join(directory, "source.json"),
      JSON.stringify(makeSource(metadata, base, permissions), null, 2) + "\n",
    );
    console.log(
      "Generated private source.json. Nothing was uploaded. iPhone access and migration remain separate checks.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
