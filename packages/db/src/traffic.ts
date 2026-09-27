import {getPool} from './index';
import type {PoolClient} from 'pg';

export type MeasuredScope = 'internet' | 'combined' | 'lan' | 'reported';
export type TrafficPoint = {bucketStart: string; uploadBytes: string | null; downloadBytes: string | null;
  uploadObservedSeconds: number | null; downloadObservedSeconds: number | null};

export async function getAvailableClientScopes(clientId: string): Promise<MeasuredScope[]> {
  const result = await getPool().query<{scope: MeasuredScope}>(`SELECT DISTINCT scope FROM traffic_rollups
    WHERE client_id=$1 AND observed_seconds>0 AND scope IN ('internet','combined','lan','reported')`, [clientId]);
  const priority: MeasuredScope[] = ['internet', 'combined', 'lan', 'reported'];
  return priority.filter(scope => result.rows.some(row => row.scope === scope));
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
  const scopeResult = await executor.query<{scope: MeasuredScope}>(`SELECT scope FROM traffic_rollups
    WHERE resolution='5m' AND bucket_start >= $1 AND bucket_start < $2 AND site_id=$3 AND observed_seconds>0
      AND scope IN ('internet','combined','lan','reported')
    GROUP BY scope ORDER BY CASE scope WHEN 'internet' THEN 0 WHEN 'combined' THEN 1 WHEN 'lan' THEN 2 ELSE 3 END LIMIT 1`,
    [alignedStart, alignedEnd, siteId]);
  const scope = scopeResult.rows[0]?.scope;
  if (!scope) return null;
  const [grouped, leaders] = await Promise.all([
    executor.query<{bucket_start: Date; direction: string; bytes: string}>(`SELECT bucket_start,direction,sum(bytes)::text AS bytes
      FROM traffic_rollups WHERE scope=$1 AND resolution='5m' AND bucket_start >= $2 AND bucket_start < $3 AND site_id=$4
        AND observed_seconds>0 AND direction IN ('upload','download')
      GROUP BY 1,2 ORDER BY 1,2`, [scope, alignedStart, alignedEnd, siteId]),
    executor.query<{id: string; name: string | null; mac: string; total_bytes: string}>(`SELECT c.id,c.name,c.mac,sum(r.bytes)::text AS total_bytes
      FROM traffic_rollups r JOIN clients c ON c.id=r.client_id
      WHERE r.scope=$1 AND r.resolution='5m' AND r.bucket_start >= $2 AND r.bucket_start < $3 AND r.site_id=$4
        AND r.observed_seconds>0 AND r.direction IN ('upload','download')
      GROUP BY c.id,c.name,c.mac ORDER BY sum(r.bytes) DESC,c.id LIMIT 5`,
    [scope, alignedStart, alignedEnd, siteId])
  ]);
  const points = new Map<string, TrafficPoint>();
  let upload = 0n;
  let download = 0n;
  let hasUpload = false;
  let hasDownload = false;
  for (const row of grouped.rows) {
    const key = row.bucket_start.toISOString();
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
    topClients: leaders.rows.map(row => ({id: row.id, name: row.name, mac: row.mac, totalBytes: row.total_bytes}))};
}
