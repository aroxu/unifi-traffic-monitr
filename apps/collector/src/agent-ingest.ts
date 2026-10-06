import type {PoolClient} from 'pg';
import type {AgentBucket} from './agent-protocol';

const scopes = ['internet', 'lan'] as const;

/**
 * Ledger writers for a site run one at a time. Storing agent buckets and
 * attaching buckets to newly listed clients rebuild overlapping rollup rows
 * from different connections, which could otherwise deadlock.
 */
async function lockLedger(client: PoolClient, siteId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['utm-agent-ledger', siteId]);
}

/**
 * Rebuild agent-owned rollups for the given buckets. Both resolutions are
 * replaced, never added. Rows from different agent runs of the same bucket are
 * summed, because a restarted agent counts that bucket again from zero.
 */
async function applyRollups(client: PoolClient, siteId: string, starts: Date[]): Promise<void> {
  if (!starts.length) return;
  const unique = [...new Set(starts.map(d => d.getTime()))].map(ms => new Date(ms));
  await client.query(`INSERT INTO traffic_rollups
      (site_id,client_id,scope,direction,resolution,bucket_start,bytes,observed_seconds,gap_count,reset_count,estimated)
    SELECT site_id, client_id, scope, direction, '5m', bucket_start, sum(bytes)::bigint,
      LEAST(300, sum(coverage_seconds))::int,
      CASE WHEN bool_or(final) AND sum(coverage_seconds) < 300 THEN 1 ELSE 0 END, 0, false
    FROM agent_buckets WHERE site_id=$1 AND client_id IS NOT NULL AND bucket_start = ANY($2::timestamptz[])
    GROUP BY site_id, client_id, scope, direction, bucket_start
    ON CONFLICT (client_id,scope,direction,resolution,bucket_start) DO UPDATE SET
      bytes=EXCLUDED.bytes, observed_seconds=EXCLUDED.observed_seconds, gap_count=EXCLUDED.gap_count,
      reset_count=0, estimated=false`, [siteId, unique]);
  // Recompute only the client hours these buckets touched. The lateral join
  // reads each client's five-minute rows through the rollup key instead of
  // scanning every rollup; OFFSET 0 stops the planner from turning it back
  // into a plain join.
  await client.query(`INSERT INTO traffic_rollups
      (site_id,client_id,scope,direction,resolution,bucket_start,bytes,observed_seconds,gap_count,reset_count,estimated)
    SELECT $1, t.client_id, r.scope, r.direction, '1h', t.hour, sum(r.bytes)::bigint,
      LEAST(3600, sum(r.observed_seconds))::int, sum(r.gap_count)::int, 0, false
    FROM (SELECT DISTINCT client_id, date_bin('1 hour', bucket_start, timestamptz '1970-01-01 00:00:00+00') AS hour
      FROM agent_buckets WHERE site_id=$1 AND client_id IS NOT NULL AND bucket_start = ANY($2::timestamptz[])) t
    CROSS JOIN LATERAL (SELECT scope, direction, bytes, observed_seconds, gap_count FROM traffic_rollups
      WHERE client_id=t.client_id AND scope IN ('internet','lan') AND direction IN ('upload','download')
        AND resolution='5m' AND bucket_start >= t.hour AND bucket_start < t.hour + interval '1 hour' OFFSET 0) r
    GROUP BY t.client_id, r.scope, r.direction, t.hour
    ON CONFLICT (client_id,scope,direction,resolution,bucket_start) DO UPDATE SET
      bytes=EXCLUDED.bytes, observed_seconds=EXCLUDED.observed_seconds, gap_count=EXCLUDED.gap_count,
      reset_count=0, estimated=false`, [siteId, unique]);
}

/**
 * Store agent buckets and derive rollups in one transaction. Within one agent
 * run a later message for the same bucket replaces the earlier values, and a
 * partial update never overwrites a final one.
 */
export async function ingestAgentBuckets(client: PoolClient, siteId: string, buckets: AgentBucket[], runId = ''): Promise<{rows: number; lastFinal: Date | null}> {
  const subject: string[] = [], start: Date[] = [], scope: string[] = [], direction: string[] = [];
  const bytes: string[] = [], coverage: number[] = [], final: boolean[] = [];
  let lastFinal: Date | null = null;
  for (const bucket of buckets) {
    if (bucket.final && (!lastFinal || bucket.start > lastFinal)) lastFinal = bucket.start;
    for (const s of bucket.subjects) {
      for (const name of scopes) {
        for (const [dir, value] of [['upload', s[name].up], ['download', s[name].down]] as const) {
          subject.push(s.mac); start.push(bucket.start); scope.push(name); direction.push(dir);
          bytes.push(value.toString()); coverage.push(bucket.coverageSeconds); final.push(bucket.final);
        }
      }
    }
  }
  await client.query('BEGIN');
  try {
    await lockLedger(client, siteId);
    if (subject.length) {
      await client.query(`INSERT INTO agent_buckets
          (site_id,subject,bucket_start,scope,direction,bytes,coverage_seconds,final,client_id,received_at,run_id)
        SELECT $1, v.subject, v.bucket_start, v.scope, v.direction, v.bytes, v.coverage, v.final,
          (SELECT c.id FROM clients c WHERE c.site_id=$1 AND c.mac=v.subject), now(), $9
        FROM unnest($2::text[],$3::timestamptz[],$4::text[],$5::text[],$6::bigint[],$7::int[],$8::bool[])
          AS v(subject,bucket_start,scope,direction,bytes,coverage,final)
        ON CONFLICT (site_id,subject,bucket_start,scope,direction,run_id) DO UPDATE SET
          bytes=EXCLUDED.bytes, coverage_seconds=EXCLUDED.coverage_seconds, final=EXCLUDED.final,
          client_id=COALESCE(agent_buckets.client_id, EXCLUDED.client_id), received_at=now()
        WHERE EXCLUDED.final OR NOT agent_buckets.final`,
        [siteId, subject, start, scope, direction, bytes, coverage, final, runId]);
      await applyRollups(client, siteId, buckets.map(b => b.start));
    }
    if (lastFinal) await client.query(`INSERT INTO agent_status (site_id,last_final_bucket,updated_at) VALUES ($1,$2,now())
      ON CONFLICT (site_id) DO UPDATE SET last_final_bucket=GREATEST(agent_status.last_final_bucket, EXCLUDED.last_final_bucket),
      updated_at=now()`, [siteId, lastFinal]);
    await client.query('COMMIT');
    return {rows: subject.length, lastFinal};
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/**
 * Attach buckets to clients that the API listed after the agent reported them.
 * since is rounded up to an hour so a partly pruned hour is never rebuilt. The
 * literal 'unattributed' lets the planner use the partial index that skips
 * those rows, so each client is one index probe.
 */
export async function resolveAgentClients(client: PoolClient, siteId: string, since: Date): Promise<number> {
  const hourStart = new Date(Math.ceil(since.getTime() / 3600000) * 3600000);
  await client.query('BEGIN');
  try {
    await lockLedger(client, siteId);
    const resolved = await client.query<{bucket_start: Date}>(`WITH updated AS (
        UPDATE agent_buckets b SET client_id=c.id FROM clients c
        WHERE b.site_id=$1 AND b.client_id IS NULL AND b.subject <> 'unattributed' AND b.bucket_start >= $2
          AND c.site_id=b.site_id AND c.mac=b.subject
        RETURNING b.bucket_start)
      SELECT DISTINCT bucket_start FROM updated`, [siteId, hourStart]);
    await applyRollups(client, siteId, resolved.rows.map(row => row.bucket_start));
    await client.query('COMMIT');
    return resolved.rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** The newest final bucket this database has stored, used to resume the agent stream. */
export async function agentResumePoint(client: PoolClient, siteId: string): Promise<Date | null> {
  const result = await client.query<{since: Date | null}>(`SELECT GREATEST(
      (SELECT last_final_bucket FROM agent_status WHERE site_id=$1),
      (SELECT max(bucket_start) FROM agent_buckets WHERE site_id=$1 AND final)) AS since`, [siteId]);
  return result.rows[0]?.since ?? null;
}
