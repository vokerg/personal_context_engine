#!/usr/bin/env bash
# Reproducible API-only Linux/Node 22 release. No VM build or credentials.
set -euo pipefail
output=$1
[[ -n $output ]] || { echo 'Usage: bash deploy/gcp/package-api.sh OUTPUT_DIRECTORY' >&2; exit 2; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]]
mkdir -p "$output"
output=$(realpath "$output")
stage=$(mktemp -d)
relocated=$(mktemp -d)
trap 'rm -rf "$stage" "$relocated"' EXIT

npm run prisma:generate
npm run build -w @pce/contracts
npm run build -w @pce/core
npm run build -w @pce/db
npm run build -w @pce/api

# Explicit allowlist: no .env, source, private content or CI secrets.
cp package.json package-lock.json "$stage/"
node --input-type=module - "$stage" <<'JS'
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const target = process.argv[2];
for (const workspace of JSON.parse(readFileSync('package.json')).workspaces) {
  mkdirSync(join(target, workspace), { recursive: true });
  copyFileSync(join(workspace, 'package.json'), join(target, workspace, 'package.json'));
}
JS
(cd "$stage" && npm ci --omit=dev --ignore-scripts --workspace=@pce/api --no-audit --no-fund)
for workspace in packages/contracts packages/core packages/db apps/api; do
  cp -R "$workspace/dist" "$stage/$workspace/"
done
cp -R node_modules/.prisma "$stage/node_modules/"
mkdir -p "$stage/runtime"
node_binary=$(node -p 'process.execPath')
cp -L "$node_binary" "$stage/runtime/node"
cp "$(dirname "$(dirname "$node_binary")")/LICENSE" "$stage/runtime/NODE-LICENSE"
python3 - "$stage" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve()
for path in root.rglob('*'):
    if path.name == '.env' or path.name.startswith(('.env.', 'gha-creds-')):
        raise SystemExit('Private configuration in release')
    if path.is_symlink() and not path.resolve().is_relative_to(root):
        raise SystemExit('External symlink in release')
if not list(root.glob('node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node')):
    raise SystemExit('Missing Debian OpenSSL 3 Prisma engine')
PY
git rev-parse HEAD > "$stage/REVISION"
tar -czf "$output/api.tar.gz" -C "$stage" .
(cd "$output" && sha256sum api.tar.gz > api.tar.gz.sha256)
tar -xzf "$output/api.tar.gz" -C "$relocated"
(cd "$relocated" && runtime/node --input-type=module -e "await Promise.all([import('@pce/db'),import('@prisma/client')])")
"$relocated/runtime/node" --check "$relocated/apps/api/dist/main.js"
echo 'Validated isolated API artifact; no deployment performed'
