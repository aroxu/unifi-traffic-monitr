#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 START_UTC_ISO8601" >&2
  exit 2
fi

if ! start_epoch="$(date -u -d "$1" +%s 2>/dev/null)" || (( start_epoch > $(date -u +%s) )); then
  echo 'Start must be a valid time no later than now.' >&2
  exit 2
fi

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.local.yaml \
  exec -T db psql -X -v ON_ERROR_STOP=1 -v since="$1" -U traffic -d traffic <<'SQL'
\pset pager off
\echo 'Collection window'
WITH bounds AS (SELECT :'since'::timestamptz AS started_at, clock_timestamp() AS checked_at),
runs AS (SELECT r.site_id, r.started_at, r.status, r.error_code
  FROM collector_runs r CROSS JOIN bounds b WHERE r.started_at >= b.started_at),
successes AS (SELECT started_at FROM runs
  WHERE status IN ('raw_only','identity_only','measured')),
success_gaps AS (SELECT extract(epoch FROM started_at - lag(started_at)
  OVER (ORDER BY started_at)) AS seconds FROM successes),
coverage_gaps AS (
  SELECT extract(epoch FROM (SELECT min(started_at) FROM successes)-b.started_at) AS seconds
    FROM bounds b WHERE EXISTS (SELECT 1 FROM successes)
  UNION ALL SELECT seconds FROM success_gaps WHERE seconds IS NOT NULL
  UNION ALL SELECT extract(epoch FROM b.checked_at-coalesce((SELECT max(started_at) FROM successes),b.started_at))
    FROM bounds b)
SELECT b.started_at AS observation_start_utc,
  b.checked_at AS checked_at_utc,
  round(extract(epoch FROM b.checked_at-b.started_at)/3600,2) AS elapsed_hours,
  (SELECT count(*) FROM successes) AS successful_cycles,
  (SELECT count(*) FROM runs WHERE status = 'error') AS failed_cycles,
  (SELECT round(max(seconds)::numeric,1) FROM success_gaps) AS longest_success_gap_seconds,
  (SELECT round(max(seconds)::numeric,1) FROM coverage_gaps) AS longest_coverage_gap_seconds,
  (SELECT round(extract(epoch FROM b.checked_at-max(started_at))::numeric,1) FROM successes) AS latest_success_age_seconds,
  (SELECT count(*) FROM client_samples s WHERE s.collected_at >= b.started_at) AS samples_in_window,
  (SELECT count(*) FROM traffic_intervals t WHERE t.end_at >= b.started_at) AS intervals_in_window,
  (SELECT count(*) FROM traffic_rollups) AS retained_rollups,
  pg_database_size(current_database()) AS database_bytes
FROM bounds b;

\echo 'Failure codes in window'
SELECT coalesce(error_code,'unspecified') AS error_code, count(*) AS cycles
FROM collector_runs WHERE started_at >= :'since'::timestamptz AND status='error'
GROUP BY error_code ORDER BY cycles DESC,error_code;

\echo 'Latest collection'
SELECT status, client_count, started_at, finished_at
FROM collector_runs ORDER BY started_at DESC LIMIT 1;
SQL
