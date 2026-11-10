#!/usr/bin/env bash
# Configuration verification with synthetic TLS material; never starts a server.
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=pce.example.invalid \
  -keyout "$stage/privkey.pem" -out "$stage/fullchain.pem" >/dev/null 2>&1
python3 - "$source_dir" "$stage" <<'PY'
from pathlib import Path
import sys
source, stage = map(Path, sys.argv[1:])
config = (source / 'nginx-api.conf.example').read_text().replace('PCE_API_HOSTNAME', 'pce.example.invalid')
config = config.replace('/etc/letsencrypt/live/pce.example.invalid/', str(stage) + '/')
config = config.replace('/etc/nginx/snippets/pce-api-proxy.conf', str(source / 'nginx-api-proxy.conf'))
config = config.replace('listen [::]:80;', 'listen [::]:18080;').replace('listen [::]:443 ssl;', 'listen [::]:18443 ssl;')
(stage / 'nginx.conf').write_text('pid ' + str(stage / 'nginx.pid') + ';\nevents {}\nhttp {\n' + config + '\n}\n')
PY
nginx -t -e stderr -p "$stage" -c "$stage/nginx.conf"
