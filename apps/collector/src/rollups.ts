import {allocateInterval} from '@utm/metrics';
import type {PoolClient} from 'pg';

export type MeasuredScope = 'internet' | 'lan' | 'combined' | 'reported';
export type MeasuredDirection = 'upload' | 'download';
const resolutions = [{name: '5m', seconds: 300}, {name: '1h', seconds: 3600}] as const;

type RollupAddition = {clientId: string; scope: MeasuredScope; direction: MeasuredDirection; resolution: '5m' | '1h';
  bucketStart: Date; bytes: bigint; observedSeconds: number; gaps: number; resets: number; estimated: boolean};

/**
 * Rollup additions for one transaction. Additions to the same bucket are
 * merged, so a single upsert can apply them all.
 */
export class RollupBatch {
  private readonly rows = new Map<string, RollupAddition>();

  private add(row: RollupAddition): void {
    const key = JSON.stringify([row.clientId, row.scope, row.direction, row.resolution, row.bucketStart.getTime()]);
    const merged = this.rows.get(key);
    if (!merged) { this.rows.set(key, row); return; }
    merged.bytes += row.bytes;
    merged.observedSeconds += row.observedSeconds;
    merged.gaps += row.gaps;
    merged.resets += row.resets;
    merged.estimated ||= row.estimated;
  }

  addInterval(clientId: string, scope: MeasuredScope, direction: MeasuredDirection, start: Date, end: Date,
    bytes: bigint, estimated: boolean): void {
    for (const resolution of resolutions) {
      for (const bucket of allocateInterval(bytes, start, end, resolution.seconds)) {
        this.add({clientId, scope, direction, resolution: resolution.name, bucketStart: bucket.bucketStart,
          bytes: bucket.bytes, observedSeconds: bucket.observedSeconds, gaps: 0, resets: 0, estimated});
      }
    }
  }

  addQuality(clientId: string, scope: MeasuredScope, direction: MeasuredDirection, at: Date, quality: 'gap' | 'reset'): void {
    for (const resolution of resolutions) {
      const bucketStart = new Date(Math.floor(at.getTime() / (resolution.seconds * 1000)) * resolution.seconds * 1000);
      this.add({clientId, scope, direction, resolution: resolution.name, bucketStart, bytes: 0n, observedSeconds: 0,
        gaps: quality === 'gap' ? 1 : 0, resets: quality === 'reset' ? 1 : 0, estimated: true});
    }
  }

  async write(client: PoolClient, siteId: string): Promise<void> {
    const rows = [...this.rows.values()];
    if (!rows.length) return;
    await client.query(`INSERT INTO traffic_rollups
      (site_id,client_id,scope,direction,resolution,bucket_start,bytes,observed_seconds,gap_count,reset_count,estimated)
      SELECT $1, v.client_id, v.scope, v.direction, v.resolution, v.bucket_start, v.bytes, v.observed_seconds,
        v.gap_count, v.reset_count, v.estimated
      FROM unnest($2::uuid[],$3::text[],$4::text[],$5::text[],$6::timestamptz[],$7::bigint[],$8::int[],$9::int[],$10::int[],$11::bool[])
        AS v(client_id,scope,direction,resolution,bucket_start,bytes,observed_seconds,gap_count,reset_count,estimated)
      ON CONFLICT (client_id,scope,direction,resolution,bucket_start) DO UPDATE SET
        bytes=traffic_rollups.bytes+EXCLUDED.bytes,
        observed_seconds=traffic_rollups.observed_seconds+EXCLUDED.observed_seconds,
        gap_count=traffic_rollups.gap_count+EXCLUDED.gap_count,
        reset_count=traffic_rollups.reset_count+EXCLUDED.reset_count,
        estimated=traffic_rollups.estimated OR EXCLUDED.estimated`,
      [siteId, rows.map(row => row.clientId), rows.map(row => row.scope), rows.map(row => row.direction),
        rows.map(row => row.resolution), rows.map(row => row.bucketStart), rows.map(row => row.bytes.toString()),
        rows.map(row => row.observedSeconds), rows.map(row => row.gaps), rows.map(row => row.resets),
        rows.map(row => row.estimated)]);
  }
}

export async function recordIntervalRollups(client: PoolClient, siteId: string, clientId: string,
  scope: MeasuredScope, direction: MeasuredDirection, start: Date, end: Date, bytes: bigint,
  estimated: boolean): Promise<void> {
  const batch = new RollupBatch();
  batch.addInterval(clientId, scope, direction, start, end, bytes, estimated);
  await batch.write(client, siteId);
}

export async function recordQualityRollups(client: PoolClient, siteId: string, clientId: string,
  scope: MeasuredScope, direction: MeasuredDirection, at: Date, quality: 'gap' | 'reset'): Promise<void> {
  const batch = new RollupBatch();
  batch.addQuality(clientId, scope, direction, at, quality);
  await batch.write(client, siteId);
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
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
