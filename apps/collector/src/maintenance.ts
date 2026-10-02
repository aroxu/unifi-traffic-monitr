import type {PoolClient} from 'pg';

type Retention = {raw_retention_days: number; five_minute_retention_days: number; hourly_retention_days: number};

const day = 86400000;
// The agent keeps at most 7 days in memory, so a replay never needs older ledger rows.
const minAgentLedgerDays = 8;
// Collection runs stay a month for troubleshooting, or longer while samples still refer to them.
const minRunHistoryDays = 30;

async function retentionDays(client: PoolClient): Promise<Retention> {
  const result = await client.query<Retention>(`SELECT raw_retention_days,five_minute_retention_days,hourly_retention_days
    FROM settings WHERE id=1`);
  const days = result.rows[0] ?? {raw_retention_days: 7, five_minute_retention_days: 90, hourly_retention_days: 365};
  const {raw_retention_days: raw, five_minute_retention_days: five, hourly_retention_days: hourly} = days;
  if (![raw, five, hourly].every(Number.isSafeInteger) || raw < 1 || raw > 90 ||
      five < raw || five > 365 || hourly < five || hourly > 3650) throw new Error('Invalid retention settings');
  return days;
}

/**
 * Oldest gateway agent bucket worth keeping. The ledger is raw data: its
 * totals already live in the five-minute and hourly rollups.
 */
export function agentLedgerCutoff(rawRetentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - Math.max(rawRetentionDays, minAgentLedgerDays) * day);
}

export async function currentAgentLedgerCutoff(client: PoolClient, now = new Date()): Promise<Date> {
  return agentLedgerCutoff((await retentionDays(client)).raw_retention_days, now);
}

async function deleteBatches(client: PoolClient, query: string, values: unknown[]): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < 10; batch++) {
    const result = await client.query(query, values);
    removed += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < 10000) break;
  }
  return removed;
}

async function pruneSamples(client: PoolClient, siteId: string, cutoff: Date): Promise<number> {
  return deleteBatches(client, `WITH stale AS (
    SELECT s.id FROM client_samples s WHERE s.site_id=$1 AND s.collected_at < $2
      AND (s.scope='unknown' OR s.rollup_applied)
      AND NOT EXISTS (SELECT 1 FROM traffic_intervals t WHERE t.sample_id=s.id)
    ORDER BY s.collected_at LIMIT 10000
  ) DELETE FROM client_samples s USING stale WHERE s.id=stale.id RETURNING s.id`, [siteId, cutoff]);
}

/** Remove raw samples only after no retained interval refers to them. */
export async function pruneRawSamples(client: PoolClient, siteId: string, now = new Date()): Promise<number> {
  const days = await retentionDays(client);
  return pruneSamples(client, siteId, new Date(now.getTime() - days.raw_retention_days * day));
}

/** Rollups are committed before any detailed interval can be removed. */
export async function pruneExpiredHistory(client: PoolClient, siteId: string, now = new Date()): Promise<{
  intervals: number; samples: number; rollups: number; agentBuckets: number; runs: number
}> {
  const days = await retentionDays(client);
  const rawCutoff = new Date(now.getTime() - days.raw_retention_days * day);
  const intervals = await deleteBatches(client, `WITH stale AS (
    SELECT id FROM traffic_intervals WHERE site_id=$1 AND rollup_applied AND end_at < $2
    ORDER BY end_at LIMIT 10000
  ) DELETE FROM traffic_intervals t USING stale WHERE t.id=stale.id RETURNING t.id`, [siteId, rawCutoff]);
  const samples = await pruneSamples(client, siteId, rawCutoff);
  const fiveCutoff = new Date(now.getTime() - days.five_minute_retention_days * day);
  const hourCutoff = new Date(now.getTime() - days.hourly_retention_days * day);
  const rollups = await deleteBatches(client, `WITH stale AS (
    SELECT id FROM traffic_rollups WHERE site_id=$1 AND
      ((resolution='5m' AND bucket_start < $2) OR (resolution='1h' AND bucket_start < $3))
    ORDER BY bucket_start LIMIT 10000
  ) DELETE FROM traffic_rollups r USING stale WHERE r.id=stale.id RETURNING r.id`,
    [siteId, fiveCutoff, hourCutoff]);
  const agentBuckets = await deleteBatches(client, `WITH stale AS (
    SELECT id FROM agent_buckets WHERE site_id=$1 AND bucket_start < $2 ORDER BY bucket_start LIMIT 10000
  ) DELETE FROM agent_buckets b USING stale WHERE b.id=stale.id RETURNING b.id`, [siteId, agentLedgerCutoff(days.raw_retention_days, now)]);
  const runCutoff = new Date(now.getTime() - Math.max(days.raw_retention_days, minRunHistoryDays) * day);
  const runs = await deleteBatches(client, `WITH stale AS (
    SELECT r.id FROM collector_runs r WHERE r.site_id=$1 AND r.started_at < $2
      AND NOT EXISTS (SELECT 1 FROM client_samples s WHERE s.run_id=r.id)
    ORDER BY r.started_at LIMIT 10000
  ) DELETE FROM collector_runs r USING stale WHERE r.id=stale.id RETURNING r.id`, [siteId, runCutoff]);
  return {intervals, samples, rollups, agentBuckets, runs};
}
