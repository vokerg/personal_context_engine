#!/usr/bin/env bash
# Build on Linux x86_64 with Node 22. The VM installs nothing.
set -euo pipefail
output=${1:?Usage: package.sh OUTPUT_DIRECTORY}
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]]
mkdir -p "$output"
output=$(realpath "$output")
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
npm run prisma:generate
npm run build -w @pce/core
npm run build -w @pce/db
npm run build -w @pce/worker
# Explicit allowlist: no .env, source checkout, private content or CI credentials.
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
# The locked worker closure only. Never copy the checkout's development modules.
(cd "$stage" && npm ci --omit=dev --ignore-scripts --workspace=@pce/worker --no-audit --no-fund)
for workspace in packages/core packages/db apps/worker; do
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
tar -czf "$output/worker.tar.gz" -C "$stage" .
(cd "$output" && sha256sum worker.tar.gz > worker.tar.gz.sha256)
# Verify the actual archive in a different location, without the source modules.
relocated=$(mktemp -d)
trap 'rm -rf "$stage" "$relocated"' EXIT
tar -xzf "$output/worker.tar.gz" -C "$relocated"
(cd "$relocated" && runtime/node --input-type=module -e "await Promise.all([import('@pce/db'),import('@prisma/client')])")
# Scaffold mode never opens a DB or external connection.
env -i PATH=/usr/bin:/bin "$relocated/runtime/node" "$relocated/apps/worker/dist/main.js" > "$output/smoke.log" 2>&1 &
pid=$!
sleep 2
kill -TERM "$pid"
wait "$pid"
grep -q 'Worker scaffold stopped' "$output/smoke.log"
