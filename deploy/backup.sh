#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo 'Usage: deploy/backup.sh OUTPUT.dump' >&2
  exit 2
fi

target=$1
if [[ -e $target ]]; then
  echo 'Backup destination already exists' >&2
  exit 2
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
temporary="${target}.tmp.$$"
umask 077
trap 'rm -f -- "$temporary"' EXIT
docker compose --env-file "$repo_root/.env" -f "$repo_root/deploy/compose.yaml" exec -T db \
  pg_dump -U traffic -d traffic -Fc > "$temporary"
docker compose --env-file "$repo_root/.env" -f "$repo_root/deploy/compose.yaml" exec -T db \
  pg_restore -l < "$temporary" > /dev/null
mv -- "$temporary" "$target"
trap - EXIT
echo "Backup verified: $target"
