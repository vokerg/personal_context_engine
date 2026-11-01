#!/usr/bin/env bash
# Installed root-owned as /usr/local/sbin/pce-worker-control.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unit=pce-worker.service
operation=${1:-}
[[ $# == 1 && $operation =~ ^(start|stop|restart|status|verify)$ ]] || { echo 'Invalid operation' >&2; exit 2; }
# Lifecycle records only: application logs may contain personal data and GitHub
# Actions logs in the public source repository are public.
diagnostics() {
  systemctl show "$unit" --property=ActiveState,SubState,Result,ExecMainStatus,NRestarts
  journalctl --no-pager --unit="$unit" _PID=1 --lines=30 --output=short-iso || true
}
verify() {
  local pid restarts
  pid=$(systemctl show "$unit" --property=MainPID --value)
  restarts=$(systemctl show "$unit" --property=NRestarts --value)
  [[ $pid != 0 ]] || return 1
  for ((i=0; i<20; i++)); do
    systemctl is-active --quiet "$unit" || return 1
    [[ $(systemctl show "$unit" --property=MainPID --value) == "$pid" ]] || return 1
    [[ $(systemctl show "$unit" --property=NRestarts --value) == "$restarts" ]] || return 1
    sleep 1
  done
}
case "$operation" in
  start|restart)
    if ! systemctl "$operation" "$unit" || ! verify; then diagnostics; exit 1; fi
    ;;
  stop)
    if ! systemctl stop "$unit"; then diagnostics; exit 1; fi
    [[ $(systemctl show "$unit" --property=ActiveState --value) == inactive ]] || { diagnostics; exit 1; }
    ;;
  verify) verify || { diagnostics; exit 1; } ;;
  status) diagnostics; systemctl is-active --quiet "$unit" || exit 1 ;;
esac
printf 'pce-worker: %s succeeded\n' "$operation"
