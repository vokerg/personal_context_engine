#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
# Prefer the repository's Node major when installed through Homebrew.
for candidate in /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
  if [[ -x "$candidate/node" ]]; then export PATH="$candidate:$PATH"; break; fi
done
exec node scripts/ios/release.mjs "$@"
