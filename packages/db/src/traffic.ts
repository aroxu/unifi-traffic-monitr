import {getPool} from './index';
import type {PoolClient} from 'pg';

export type MeasuredScope = 'internet' | 'combined' | 'lan' | 'reported';
export type TrafficPoint = {bucketStart: string; uploadBytes: string | null; downloadBytes: string | null;
  uploadObservedSeconds: number | null; downloadObservedSeconds: number | null};
// Display priority. Each lookup stops at the first matching rollup row.
const scopePriority = `unnest(ARRAY['internet','combined','lan','reported']::text[]) WITH ORDINALITY AS s(scope, priority)`;

export async function getAvailableClientScopes(clientId: string): Promise<MeasuredScope[]> {
  const result = await getPool().query<{scope: MeasuredScope}>(`SELECT s.scope FROM ${scopePriority}
    WHERE EXISTS (SELECT 1 FROM traffic_rollups r WHERE r.client_id=$1 AND r.scope=s.scope AND r.observed_seconds>0)
    ORDER BY s.priority`, [clientId]);
  return result.rows.map(row => row.scope);
}

/** Scopes with any measured usage, in display priority. */
export async function getMeasuredScopes(): Promise<MeasuredScope[]> {
  const result = await getPool().query<{scope: MeasuredScope}>(`SELECT s.scope FROM ${scopePriority}
    WHERE EXISTS (SELECT 1 FROM traffic_rollups r WHERE r.scope=s.scope AND r.observed_seconds>0)
    ORDER BY s.priority`);
  return result.rows.map(row => row.scope);
}

export async function getClientTraffic(clientId: string, scope: MeasuredScope, start: Date, end: Date, client?: PoolClient) {
  const duration = end.getTime() - start.getTime();
  const bucketSeconds = duration <= 2 * 86400000 ? 300 : duration <= 10 * 86400000 ? 3600 : 7200;
  const bucketMs = bucketSeconds * 1000;
  const alignedStart = new Date(Math.floor(start.getTime() / bucketMs) * bucketMs);
  const alignedEnd = new Date(Math.ceil(end.getTime() / bucketMs) * bucketMs);
  const resolution = bucketSeconds === 300 ? '5m' : '1h';
  const grouped = await (client ?? getPool()).query<{bucket_start: Date; direction: string; bytes: string | null;
    observed_seconds: number}>(`SELECT
    date_bin(make_interval(secs => $5::int), bucket_start, timestamptz '1970-01-01 00:00:00+00') AS bucket_start,
    direction, sum(bytes) FILTER (WHERE observed_seconds > 0)::text AS bytes,
    sum(observed_seconds)::int AS observed_seconds
    FROM traffic_rollups WHERE client_id=$1 AND scope=$2 AND bucket_start >= $3 AND bucket_start < $4
      AND resolution=$6 AND direction IN ('upload','download')
    GROUP BY 1,2 ORDER BY 1,2`,
    [clientId, scope, alignedStart, alignedEnd, bucketSeconds, resolution]);
  const buckets = new Map<string, TrafficPoint>();
  let upload = 0n;
  let download = 0n;
  let hasUpload = false;
  let hasDownload = false;
  for (const row of grouped.rows) {
    const key = row.bucket_start.toISOString();
    const point = buckets.get(key) ?? {bucketStart: key, uploadBytes: null, downloadBytes: null,
      uploadObservedSeconds: null, downloadObservedSeconds: null};
    if (row.direction === 'upload' && row.bytes !== null) {point.uploadBytes = row.bytes;
      point.uploadObservedSeconds = row.observed_seconds; upload += BigInt(row.bytes); hasUpload = true;}
    if (row.direction === 'download' && row.bytes !== null) {point.downloadBytes = row.bytes;
      point.downloadObservedSeconds = row.observed_seconds; download += BigInt(row.bytes); hasDownload = true;}
    buckets.set(key, point);
  }
  return {scope, start: alignedStart.toISOString(), end: alignedEnd.toISOString(),
    requestedStart: start.toISOString(), requestedEnd: end.toISOString(),
    boundaryEstimated: alignedStart.getTime() !== start.getTime() || alignedEnd.getTime() !== end.getTime(), bucketSeconds,
    rateBasis: 'observed' as const,
    uploadBytes: hasUpload ? upload.toString() : null, downloadBytes: hasDownload ? download.toString() : null,
    points: [...buckets.values()]};
}

export async function getOverviewTraffic(start: Date, end: Date, siteId: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const bucketSeconds = 300;
  const bucketMs = bucketSeconds * 1000;
  const alignedStart = new Date(Math.floor(start.getTime() / bucketMs) * bucketMs);
  const alignedEnd = new Date(Math.ceil(end.getTime() / bucketMs) * bucketMs);
  const scopeResult = await executor.query<{scope: MeasuredScope}>(`SELECT s.scope FROM ${scopePriority}
    WHERE EXISTS (SELECT 1 FROM traffic_rollups r WHERE r.scope=s.scope AND r.resolution='5m'
      AND r.bucket_start >= $1 AND r.bucket_start < $2 AND r.site_id=$3 AND r.observed_seconds>0)
    ORDER BY s.priority LIMIT 1`, [alignedStart, alignedEnd, siteId]);
  const scope = scopeResult.rows[0]?.scope;
  if (!scope) return null;
  // One pass over the window feeds both the chart and the top clients.
  const result = await executor.query<{kind: 'point' | 'leader'; bucket_start: Date | null; direction: string | null;
    id: string | null; name: string | null; mac: string | null; bytes: string}>(`WITH picked AS MATERIALIZED (
      SELECT client_id, bucket_start, direction, bytes FROM traffic_rollups
      WHERE scope=$1 AND resolution='5m' AND bucket_start >= $2 AND bucket_start < $3 AND site_id=$4
        AND observed_seconds>0 AND direction IN ('upload','download'))
    SELECT 'point' AS kind, bucket_start, direction, NULL::uuid AS id, NULL::text AS name, NULL::text AS mac,
      sum(bytes)::text AS bytes FROM picked GROUP BY bucket_start, direction
    UNION ALL
    SELECT 'leader', NULL, NULL, c.id, c.name, c.mac, l.bytes::text
      FROM (SELECT client_id, sum(bytes) AS bytes FROM picked GROUP BY client_id ORDER BY sum(bytes) DESC, client_id LIMIT 5) l
      JOIN clients c ON c.id=l.client_id`, [scope, alignedStart, alignedEnd, siteId]);
  const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const grouped = result.rows.filter(row => row.kind === 'point')
    .sort((a, b) => a.bucket_start!.getTime() - b.bucket_start!.getTime() || byText(a.direction!, b.direction!));
  // Same order as SQL: most bytes first, then client ID.
  const leaders = result.rows.filter(row => row.kind === 'leader')
    .sort((a, b) => { const diff = BigInt(b.bytes) - BigInt(a.bytes); return diff > 0n ? 1 : diff < 0n ? -1 : byText(a.id!, b.id!); });
  const points = new Map<string, TrafficPoint>();
  let upload = 0n;
  let download = 0n;
  let hasUpload = false;
  let hasDownload = false;
  for (const row of grouped) {
    const key = row.bucket_start!.toISOString();
    const point = points.get(key) ?? {bucketStart: key, uploadBytes: null, downloadBytes: null,
      uploadObservedSeconds: null, downloadObservedSeconds: null};
    if (row.direction === 'upload') {point.uploadBytes = row.bytes; point.uploadObservedSeconds = bucketSeconds;
      upload += BigInt(row.bytes); hasUpload = true;}
    if (row.direction === 'download') {point.downloadBytes = row.bytes; point.downloadObservedSeconds = bucketSeconds;
      download += BigInt(row.bytes); hasDownload = true;}
    points.set(key, point);
  }
  return {scope, start: alignedStart.toISOString(), end: alignedEnd.toISOString(),
    requestedStart: start.toISOString(), requestedEnd: end.toISOString(),
    boundaryEstimated: alignedStart.getTime() !== start.getTime() || alignedEnd.getTime() !== end.getTime(),
    bucketSeconds, rateBasis: 'wall' as const, uploadBytes: hasUpload ? upload.toString() : null,
    downloadBytes: hasDownload ? download.toString() : null, points: [...points.values()],
    topClients: leaders.map(row => ({id: row.id!, name: row.name, mac: row.mac!, totalBytes: row.bytes}))};
}
