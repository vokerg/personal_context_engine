/** Shared deployment inputs. Unknown build inputs conservatively affect both. */
const shared = new Set(["package.json", "package-lock.json", ".nvmrc"]);
export const backendIgnoredPaths = [
  "apps/web/**",
  "apps/mobile/**",
  "docs/**",
  ".agents/**",
  ".github/ISSUE_TEMPLATE/**",
  ".github/pull_request_template.md",
  ".github/workflows/docs.yml",
  ".github/workflows/ios-device-release-skill.yml",
  "vercel.json",
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "INTENT.md",
  ".env.example",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
];
const ignored = (path) =>
  backendIgnoredPaths.some((pattern) =>
    pattern.endsWith("/**")
      ? path.startsWith(pattern.slice(0, -2))
      : path === pattern,
  );
export function affectedServices(paths) {
  const result = { frontend: false, backend: false };
  for (const filename of paths) {
    const path = String(filename).replace(/^\.\//, "");
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      result.frontend = result.backend = true;
    } else if (path.startsWith("apps/web/") || path === "vercel.json") {
      result.frontend = true;
    } else if (
      path.startsWith("apps/api/") ||
      path.startsWith("apps/worker/") ||
      path.startsWith("deploy/gcp/") ||
      path === "render.yaml" ||
      path === "scripts/deploy-migrate.mjs"
    ) {
      result.backend = true;
    } else if (path.startsWith("packages/api-client/")) {
      result.frontend = true;
      // Render's Git filter conservatively includes packages, matching Sportos.
      result.backend = true;
    } else if (
      shared.has(path) ||
      /^tsconfig[^/]*\.json$/.test(path) ||
      path.startsWith("packages/") ||
      path.startsWith("scripts/deploy/")
    ) {
      result.frontend = result.backend = true;
    } else if (!ignored(path)) {
      result.frontend = result.backend = true;
    }
  }
  return result;
}
