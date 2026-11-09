#!/usr/bin/env bash
# One-time operator-only setup. Does not start a service or touch workers.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root' >&2; exit 1; }
python3 -c 'import tarfile; assert hasattr(tarfile, "data_filter")'
source_dir=$(cd "$(dirname "$0")" && pwd)
id pce-api >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/pce-api --shell /usr/sbin/nologin pce-api
install -d -o root -g root -m 0755 /opt/pce-api
install -d -o root -g root -m 0755 /opt/pce-api/releases
install -d -o root -g root -m 0755 /etc/pce
install -d -o pce-api -g pce-api -m 0700 /var/lib/pce-api
install -o root -g root -m 0755 "$source_dir/api-install.sh" /usr/local/sbin/pce-api-install
install -o root -g root -m 0644 "$source_dir/pce-api.service" /etc/systemd/system/pce-api.service
if [[ ! -e /etc/pce/api.env ]]; then
  install -o root -g root -m 0600 "$source_dir/api.env.example" /etc/pce/api.env
fi
systemctl daemon-reload
echo 'PCE API prepared, not started. Review host budget, provision credentials and publish a verified immutable release.'
