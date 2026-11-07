#!/usr/bin/env bash
# Runner-side transport only. No public IP, metadata writes or downloaded scripts.
set -euo pipefail
operation=${1:-}
[[ $operation =~ ^(deploy|start|stop|restart|status)$ ]] || exit 2
for variable in GCP_PROJECT_ID GCP_VM_NAME GCP_VM_ZONE GCP_SSH_KNOWN_HOSTS; do
  [[ -n ${!variable:-} ]] || { echo "Missing $variable" >&2; exit 1; }
done
[[ $GCP_PROJECT_ID =~ ^[a-z][a-z0-9-]+$ && $GCP_VM_NAME =~ ^[a-z][a-z0-9-]+$ && $GCP_VM_ZONE =~ ^[a-z0-9-]+$ ]] || exit 2
# gcloud supplies its own UserKnownHostsFile; seed that canonical file rather
# than relying on duplicate OpenSSH options (the first value wins).
known_hosts=${GCP_KNOWN_HOSTS_FILE:-$HOME/.ssh/google_compute_known_hosts}
mkdir -p "$(dirname "$known_hosts")"
touch "$known_hosts"
chmod 0600 "$known_hosts"
printf '%s\n' "$GCP_SSH_KNOWN_HOSTS" > "$known_hosts"
common=(--project="$GCP_PROJECT_ID" --zone="$GCP_VM_ZONE" --tunnel-through-iap --quiet --strict-host-key-checking=yes --ssh-key-expire-after=10m)
ssh_flags=(--ssh-flag='-o ConnectTimeout=30')
if [[ $operation == deploy ]]; then
  [[ ${RELEASE_SHA:-} =~ ^[0-9a-f]{40}$ && ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]]
  release="$RELEASE_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  digest=$(awk '{print $1}' "${ARTIFACT_DIR:?}/worker.tar.gz.sha256")
  [[ $digest =~ ^[0-9a-f]{64}$ ]]
  (cd "$ARTIFACT_DIR" && sha256sum --check worker.tar.gz.sha256)
  gcloud compute ssh "$GCP_VM_NAME" "${common[@]}" "${ssh_flags[@]}" \
    --command="/usr/local/bin/pce-worker-deploy prepare $release"
  gcloud compute scp "$ARTIFACT_DIR/worker.tar.gz" "$GCP_VM_NAME:/opt/pce/incoming/$release.tar.gz" "${common[@]}" \
    --scp-flag='-o ConnectTimeout=30'
  gcloud compute ssh "$GCP_VM_NAME" "${common[@]}" "${ssh_flags[@]}" \
    --command="/usr/local/bin/pce-worker-deploy deploy $release $digest"
else
  # Same server lock as deployment, including manual controls from other clients.
  gcloud compute ssh "$GCP_VM_NAME" "${common[@]}" "${ssh_flags[@]}" \
    --command="flock -w 180 /opt/pce/.operation.lock sudo -n /usr/local/sbin/pce-worker-control $operation"
fi
