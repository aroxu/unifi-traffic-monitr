import {allocateInterval} from '@utm/metrics';
import type {PoolClient} from 'pg';

export type MeasuredScope = 'internet' | 'lan' | 'combined' | 'reported';
export type MeasuredDirection = 'upload' | 'download';
const resolutions = [{name: '5m', seconds: 300}, {name: '1h', seconds: 3600}] as const;

export async function recordIntervalRollups(client: PoolClient, siteId: string, clientId: string,
  scope: MeasuredScope, direction: MeasuredDirection, start: Date, end: Date, bytes: bigint,
  estimated: boolean): Promise<void> {
  for (const resolution of resolutions) {
    for (const bucket of allocateInterval(bytes, start, end, resolution.seconds)) {
      await client.query(`INSERT INTO traffic_rollups
        (site_id,client_id,scope,direction,resolution,bucket_start,bytes,observed_seconds,gap_count,reset_count,estimated)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9)
        ON CONFLICT (client_id,scope,direction,resolution,bucket_start) DO UPDATE SET
          bytes=traffic_rollups.bytes+EXCLUDED.bytes,
          observed_seconds=traffic_rollups.observed_seconds+EXCLUDED.observed_seconds,
          estimated=traffic_rollups.estimated OR EXCLUDED.estimated`,
        [siteId, clientId, scope, direction, resolution.name, bucket.bucketStart,
          bucket.bytes.toString(), bucket.observedSeconds, estimated]);
    }
  }
}

export async function recordQualityRollups(client: PoolClient, siteId: string, clientId: string,
  scope: MeasuredScope, direction: MeasuredDirection, at: Date, quality: 'gap' | 'reset'): Promise<void> {
  for (const resolution of resolutions) {
    const bucketStart = new Date(Math.floor(at.getTime() / (resolution.seconds * 1000)) * resolution.seconds * 1000);
    await client.query(`INSERT INTO traffic_rollups
      (site_id,client_id,scope,direction,resolution,bucket_start,bytes,observed_seconds,gap_count,reset_count,estimated)
      VALUES ($1,$2,$3,$4,$5,$6,0,0,$7,$8,true)
      ON CONFLICT (client_id,scope,direction,resolution,bucket_start) DO UPDATE SET
        gap_count=traffic_rollups.gap_count+EXCLUDED.gap_count,
        reset_count=traffic_rollups.reset_count+EXCLUDED.reset_count,
        estimated=true`,
      [siteId, clientId, scope, direction, resolution.name, bucketStart,
        quality === 'gap' ? 1 : 0, quality === 'reset' ? 1 : 0]);
  }
}

/** Replays rows from earlier versions once. Rollup writes and markers commit together. */
export async function backfillPendingRollups(client: PoolClient, siteId: string, limit = 500): Promise<number> {
  await client.query('BEGIN');
  try {
    const intervals = await client.query<{id: string; client_id: string; scope: MeasuredScope;
      direction: MeasuredDirection; start_at: Date; end_at: Date; bytes: string; estimated: boolean}>(
      `SELECT id,client_id,scope,direction,start_at,end_at,bytes,estimated FROM traffic_intervals
       WHERE site_id=$1 AND NOT rollup_applied ORDER BY end_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [siteId, limit]);
    for (const row of intervals.rows) {
      await recordIntervalRollups(client, siteId, row.client_id, row.scope, row.direction,
        row.start_at, row.end_at, BigInt(row.bytes), row.estimated);
      await client.query('UPDATE traffic_intervals SET rollup_applied=true WHERE id=$1', [row.id]);
    }
    const anomalies = await client.query<{id: string; client_id: string; scope: MeasuredScope;
      direction: MeasuredDirection; collected_at: Date; quality: 'gap' | 'reset'}>(
      `SELECT id,client_id,scope,direction,collected_at,quality FROM client_samples
       WHERE site_id=$1 AND NOT rollup_applied AND scope <> 'unknown' AND quality IN ('gap','reset')
       ORDER BY collected_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [siteId, limit]);
    for (const row of anomalies.rows) {
      await recordQualityRollups(client, siteId, row.client_id, row.scope, row.direction, row.collected_at, row.quality);
      await client.query('UPDATE client_samples SET rollup_applied=true WHERE id=$1', [row.id]);
    }
    const ordinary = await client.query(`UPDATE client_samples SET rollup_applied=true WHERE id IN (
      SELECT id FROM client_samples WHERE site_id=$1 AND NOT rollup_applied AND scope <> 'unknown'
        AND quality NOT IN ('gap','reset') ORDER BY collected_at LIMIT $2 FOR UPDATE SKIP LOCKED
    )`, [siteId, limit]);
    await client.query('COMMIT');
    return intervals.rows.length + anomalies.rows.length + (ordinary.rowCount ?? 0);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
