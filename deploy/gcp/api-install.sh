#!/usr/bin/env bash
# Root/operator-only API release install; never touches /opt/pce or workers.
set -euo pipefail
[[ $EUID == 0 && $# == 3 ]] || { echo 'Usage (root): api-install.sh REVISION /absolute/path/api.tar.gz SHA256' >&2; exit 2; }
revision=$1
archive=$2
digest=$3
[[ $revision =~ ^[0-9a-f]{40}$ && $digest =~ ^[0-9a-f]{64}$ && $archive == /* && -f $archive && ! -L $archive ]] || exit 2
root=/opt/pce-api
[[ -d $root/releases && ! -L $root/releases && -f /etc/pce/api-ready ]] || { echo 'API bootstrap/readiness gate missing' >&2; exit 1; }
[[ $(stat -c %s "$archive") -le 209715200 ]] || { echo 'Oversize artifact' >&2; exit 1; }
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status
[[ $(df -Pk "$root" | awk 'NR==2 {print $4}') -ge 1572864 ]] || { echo 'Insufficient free disk' >&2; exit 1; }
exec 9>"$root/.operation.lock"
flock -w 180 9
target="$root/releases/$revision"
[[ ! -e $target && ! -L $target ]] || { echo 'Revision already installed; use explicit operator rollback instead' >&2; exit 1; }
staged=$(mktemp -d "$root/releases/.staging.XXXXXX")
previous=''
[[ ! -L $root/current ]] || previous=$(readlink -f "$root/current")
switched=false
success=false
cleanup() {
  local code=$?
  trap - EXIT
  if [[ $switched == true && $success != true ]]; then
    if [[ -n $previous && -d $previous ]]; then
      ln -s "$previous" "$root/current.restore"
      mv -Tf "$root/current.restore" "$root/current"
      systemctl restart pce-api.service || echo 'API rollback requires operator intervention' >&2
    else
      rm -f "$root/current"
      systemctl stop pce-api.service || true
    fi
    code=1
  fi
  rm -rf -- "$staged"
  if [[ $success != true ]]; then rm -rf -- "$target"; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$archive" <<'PY'
import posixpath, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    total = 0
    for index, member in enumerate(archive):
        path = posixpath.normpath(member.name)
        if index >= 100000 or member.name.startswith('/') or path == '..' or path.startswith('../'):
            raise SystemExit('Unsafe artifact path/count')
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise SystemExit('Special artifact member refused')
        if member.issym() or member.islnk():
            dest = posixpath.normpath(posixpath.join(posixpath.dirname(path), member.linkname) if member.issym() else member.linkname)
            if member.linkname.startswith('/') or dest == '..' or dest.startswith('../'):
                raise SystemExit('Artifact link escape')
        total += member.size
        if total > 786432000:
            raise SystemExit('Expanded artifact too large')
PY
python3 - "$archive" "$staged" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    archive.extractall(sys.argv[2], filter='data')
PY
[[ $(cat "$staged/REVISION") == "$revision" && -f $staged/apps/api/dist/main.js && -x $staged/runtime/node ]] || { echo 'Invalid API artifact' >&2; exit 1; }
mv "$staged" "$target"
staged=''
(cd "$target" && runtime/node --input-type=module -e "await Promise.all([import('@pce/db'),import('@prisma/client')])")
chown -R root:root "$target"
chmod -R go-w "$target"
chmod -R a+rX "$target"
ln -s "$target" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
switched=true
systemctl restart pce-api.service
ready=false
for i in $(seq 1 20); do
  if systemctl is-active --quiet pce-api.service && curl -fsS --max-time 3 http://127.0.0.1:3112/ready >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
[[ $ready == true ]] || { echo 'API readiness failed, restoring previous release' >&2; exit 1; }
success=true
echo "API ready on loopback: revision $revision"
