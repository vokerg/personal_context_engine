#!/usr/bin/env bash
# Explicit one-time operator action, never called by CI.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run bootstrap as root' >&2; exit 1; }
login=${1:?Usage: bootstrap.sh OS_LOGIN_LINUX_USERNAME}
[[ $login =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || exit 2
getent passwd "$login" >/dev/null
python3 -c 'import tarfile; assert hasattr(tarfile, "data_filter")'
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
getent group pce-deploy >/dev/null || groupadd --system pce-deploy
id pce-worker >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/pce --shell /usr/sbin/nologin pce-worker
usermod -aG pce-deploy "$login"
# Root owns the parent; deployment group may manage only releases/current links.
install -d -o root -g pce-deploy -m 2775 /opt/pce
install -d -o root -g pce-deploy -m 2771 /opt/pce/releases
install -d -o root -g pce-deploy -m 2770 /opt/pce/incoming
install -d -o root -g root -m 0755 /etc/pce
install -d -o pce-worker -g pce-worker -m 0700 /var/lib/pce
install -o root -g root -m 0755 "$source_dir/control.sh" /usr/local/sbin/pce-worker-control
install -o root -g root -m 0755 "$source_dir/deploy.sh" /usr/local/bin/pce-worker-deploy
install -o root -g root -m 0644 "$source_dir/pce-worker.service" /etc/systemd/system/pce-worker.service
sudoers=$(mktemp)
trap 'rm -f "$sudoers"' EXIT
for action in start stop restart status verify; do
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/pce-worker-control %s\n' "$login" "$action" >> "$sudoers"
done
visudo -cf "$sudoers"
install -o root -g root -m 0440 "$sudoers" /etc/sudoers.d/pce-worker
if [[ ! -f /etc/pce/worker.env ]]; then
  install -o root -g root -m 0600 "$source_dir/worker.env.example" /etc/pce/worker.env
fi
# Reuse the host's existing bounded journald configuration; do not restart it
# or alter retention for other applications on this shared VM.
systemctl daemon-reload
systemctl enable pce-worker.service
# enable only: no release exists and no worker is started here.
echo 'Installed; configure worker.env and resolve storage/egress before deploying. Reconnect the OS Login user to pick up group membership.'
