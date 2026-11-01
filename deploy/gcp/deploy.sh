#!/usr/bin/env bash
# Installed root-owned; runs WITHOUT sudo as the dedicated OS Login CI account.
set -euo pipefail
umask 0022
root=${PCE_DEPLOY_ROOT:-/opt/pce}
ready_file=${PCE_READY_FILE:-/etc/pce/worker-ready}
operation=${1:-}
release=${2:-}
[[ $operation =~ ^(prepare|deploy|rollback)$ && $release =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || { echo 'Usage: pce-worker-deploy prepare|deploy|rollback SHA-RUN-ATTEMPT [SHA256]' >&2; exit 2; }
exec 9>"$root/.operation.lock"
flock -w 180 9
[[ -f $ready_file ]] || { echo 'Operator must resolve egress, shared storage and DB configuration, then create /etc/pce/worker-ready' >&2; exit 1; }
if [[ $operation == prepare ]]; then
  # Called before upload under the same workflow/server operation lock. Remove
  # abandoned temporary deployment files, never configuration or source data.
  for upload in "$root"/incoming/*.tar.gz; do
    name=$(basename "$upload" .tar.gz)
    [[ $name =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || continue
    rm -f -- "$upload"
  done
  for stage in "$root"/releases/.staging.*; do
    [[ -d $stage && ! -L $stage ]] || continue
    rm -rf -- "$stage"
  done
  exit 0
fi
target="$root/releases/$release"
previous=''
if [[ -L $root/current ]]; then previous=$(readlink -f "$root/current"); fi
staged=''
created=false
switched=false
success=false
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ $switched == true && $success != true ]]; then
    echo 'Activation failed; restoring previous release' >&2
    if [[ -n $previous && -d $previous ]]; then
      ln -s "$previous" "$root/current.rollback"
      mv -Tf "$root/current.rollback" "$root/current"
      sudo -n /usr/local/sbin/pce-worker-control restart || echo 'ROLLBACK RESTART FAILED: operator intervention required' >&2
    else
      rm -f "$root/current"
      sudo -n /usr/local/sbin/pce-worker-control stop || true
      echo 'First deployment failed; no previous release exists' >&2
    fi
    code=1
  fi
  rm -f -- "$root/current.next" "$root/current.rollback" "$root/previous.next"
  [[ -z $staged ]] || rm -rf -- "$staged"
  if [[ $created == true && $success != true && $(readlink -f "$root/current" 2>/dev/null || true) != "$target" ]]; then
    rm -rf -- "$target"
  fi
  if [[ $operation == deploy ]]; then rm -f -- "$root/incoming/$release.tar.gz"; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ $operation == deploy ]]; then
  digest=${3:?Expected archive SHA256 required}
  [[ $digest =~ ^[0-9a-f]{64}$ && ! -e $target ]] || exit 2
  archive="$root/incoming/$release.tar.gz"
  [[ -f $archive && ! -L $archive ]]
  [[ $(stat -c %s "$archive") -le 209715200 ]] || { echo 'Archive exceeds 200 MiB' >&2; exit 1; }
  printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status
  # Includes space for unpacked release + portable Node dependencies.
  [[ $(df -Pk "$root" | awk 'NR==2 {print $4}') -ge 1572864 ]] || { echo 'Need 1.5 GiB free disk space' >&2; exit 1; }
  staged=$(mktemp -d "$root/releases/.staging.XXXXXX")
  # Reject path escapes, special files, and expansion bombs before extraction.
  python3 - "$archive" <<'PY'
import posixpath, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    total = 0
    for i, member in enumerate(archive):
        path = posixpath.normpath(member.name)
        if i > 100000 or member.name.startswith('/') or path == '..' or path.startswith('../'):
            raise SystemExit('Invalid archive path/count')
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise SystemExit('Special archive member refused')
        if member.issym() or member.islnk():
            dest = posixpath.normpath(posixpath.join(posixpath.dirname(path), member.linkname) if member.issym() else member.linkname)
            if member.linkname.startswith('/') or dest == '..' or dest.startswith('../'):
                raise SystemExit('Archive link escapes release')
        total += member.size
        if total > 786432000:
            raise SystemExit('Expanded archive exceeds 750 MiB')
PY
  python3 - "$archive" "$staged" <<'PYEXTRACT'
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    archive.extractall(sys.argv[2], filter='data')
PYEXTRACT
  [[ $(cat "$staged/REVISION") == "${release:0:40}" ]]
  [[ -f $staged/apps/worker/dist/main.js ]]
  mv "$staged" "$target"
  staged=''
  created=true
  [[ $("$target/runtime/node" -p 'process.versions.node.split(".")[0]') == 22 ]]
  (cd "$target" && "$target/runtime/node" --input-type=module -e "await Promise.all([import('@pce/db'),import('@prisma/client')])")
  touch "$target/.complete"
  # Runtime account can read/execute code but cannot edit it.
  chmod -R go-w "$target"
  chmod -R a+rX "$target"
else
  [[ -d $target && -f $target/.complete && -f $target/REVISION && -x $target/runtime/node ]]
  [[ $(cat "$target/REVISION") == "${release:0:40}" ]]
fi
# Atomic same-filesystem symlink replacement; configuration/data live elsewhere.
ln -s "$target" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
switched=true
sudo -n /usr/local/sbin/pce-worker-control restart
if [[ -n $previous && $previous != "$target" ]]; then
  ln -s "$previous" "$root/previous.next"
  mv -Tf "$root/previous.next" "$root/previous"
fi
success=true
# Retain current, previous, and at most one other release. Never prune data/env.
previous=$(readlink -f "$root/previous" 2>/dev/null || true)
extra=0
while IFS= read -r name; do
  [[ $name =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || continue
  path="$root/releases/$name"
  [[ $path != "$target" && $path != "$previous" ]] || continue
  extra=$((extra + 1))
  if ((extra > 1)); then rm -rf -- "$path"; fi
done < <(find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -nr | cut -d' ' -f2-)
echo "Active release: $release"
