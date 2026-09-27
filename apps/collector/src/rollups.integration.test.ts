import {afterAll, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {getAvailableClientScopes, getClientTraffic, getOverviewTraffic, getPool} from '@utm/db';
import {pruneExpiredHistory} from './maintenance';
import {backfillPendingRollups, recordIntervalRollups, recordQualityRollups} from './rollups';

describe.skipIf(process.env.DB_INTEGRATION !== '1')('PostgreSQL traffic rollups', () => {
  afterAll(async () => { await getPool().end(); });

  it('preserves fractional boundary interval duration and bytes through PostgreSQL queries', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`boundary-${randomUUID()}`])).rows[0].id;
      const client = (await db.query<{id: string}>(`INSERT INTO clients (site_id,mac)
        VALUES ($1,'00:00:00:00:00:07') RETURNING id`, [site])).rows[0].id;
      const start = new Date('2026-09-25T14:59:59.900Z');
      const end = new Date('2026-09-25T15:00:30.100Z');
      await recordIntervalRollups(db, site, client, 'internet', 'download', start, end, 302n, true);
      const stored = await db.query<{bytes: string; observed_seconds: number}>(`SELECT bytes::text,observed_seconds
        FROM traffic_rollups WHERE client_id=$1 AND resolution='5m' ORDER BY bucket_start`, [client]);
      expect(stored.rows).toEqual([{bytes: '1', observed_seconds: 1}, {bytes: '301', observed_seconds: 29}]);
      const traffic = await getClientTraffic(client, 'internet', start, end, db);
      expect(traffic.downloadBytes).toBe('302');
      expect(traffic.points.map(point => point.downloadObservedSeconds)).toEqual([1, 29]);
    } finally {db.release();}
  });

  it('keeps overview totals and leaders on one read snapshot during a concurrent collection', async () => {
    const writer = await getPool().connect();
    const reader = await getPool().connect();
    let inTransaction = false;
    try {
      const site = (await writer.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`snapshot-${randomUUID()}`])).rows[0].id;
      const client = (await writer.query<{id: string}>(`INSERT INTO clients (site_id,mac,name)
        VALUES ($1,'00:00:00:00:00:06','before') RETURNING id`, [site])).rows[0].id;
      const bucket = new Date(Math.floor(Date.now() / 300000) * 300000 - 600000);
      const start = bucket;
      const end = new Date(bucket.getTime() + 900000);
      const insert = (at: Date, bytes: number) => writer.query(`INSERT INTO traffic_rollups
        (site_id,client_id,scope,direction,resolution,bucket_start,bytes,observed_seconds,gap_count,reset_count)
        VALUES ($1,$2,'internet','download','5m',$3,$4,30,0,0)`, [site, client, at, bytes]);
      await insert(bucket, 100);

      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      inTransaction = true;
      await reader.query('SELECT count(*) FROM collector_runs'); // Establish the overview snapshot.
      await insert(new Date(bucket.getTime() + 300000), 200);
      await writer.query(`UPDATE clients SET name='after' WHERE id=$1`, [client]);

      const stable = await getOverviewTraffic(start, end, site, reader);
      expect(stable?.downloadBytes).toBe('100');
      expect(stable?.topClients[0]).toMatchObject({name: 'before', totalBytes: '100'});
      const current = await getOverviewTraffic(start, end, site);
      expect(current?.downloadBytes).toBe('300');
      expect(current?.topClients[0]).toMatchObject({name: 'after', totalBytes: '300'});
    } finally {
      if (inTransaction) await reader.query('ROLLBACK').catch(() => {});
      reader.release();
      writer.release();
    }
  });

  it('does not offer a scope with only gap or reset markers as measured usage', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`quality-only-${randomUUID()}`])).rows[0].id;
      const client = (await db.query<{id: string}>(`INSERT INTO clients (site_id,mac)
        VALUES ($1,'00:00:00:00:00:05') RETURNING id`, [site])).rows[0].id;
      await recordQualityRollups(db, site, client, 'internet', 'download', new Date(), 'gap');
      expect(await getAvailableClientScopes(client)).toEqual([]);
      const visible = await db.query<{scope: string}>(`SELECT DISTINCT scope FROM traffic_rollups
        WHERE client_id=$1 AND observed_seconds>0`, [client]);
      expect(visible.rows).toEqual([]);
      await db.query(`UPDATE traffic_rollups SET observed_seconds=10, bytes=100 WHERE client_id=$1`, [client]);
      expect(await getAvailableClientScopes(client)).toEqual(['internet']);
    } finally { db.release(); }
  });

  it('backfills once, splits midnight bytes exactly, and retains rollups after raw pruning', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`integration-rollup-${randomUUID()}`])).rows[0].id;
      const client = (await db.query<{id: string}>(`INSERT INTO clients (site_id,mac)
        VALUES ($1,'00:00:00:00:00:01') RETURNING id`, [site])).rows[0].id;
      const run = (await db.query<{id: string}>(`INSERT INTO collector_runs (site_id,started_at,status)
        VALUES ($1,'2026-09-25T14:59:30Z','raw_only') RETURNING id`, [site])).rows[0].id;
      const sample = (await db.query<{id: string}>(`INSERT INTO client_samples
        (site_id,client_id,run_id,source,scope,direction,counter_bytes,collected_at,quality)
        VALUES ($1,$2,$3,'test','internet','download',101,'2026-09-25T15:00:30Z','valid') RETURNING id`,
        [site, client, run])).rows[0].id;
      await db.query(`INSERT INTO traffic_intervals
        (site_id,client_id,sample_id,source,scope,direction,start_at,end_at,bytes,estimated)
        VALUES ($1,$2,$3,'test','internet','download','2026-09-25T14:59:30Z','2026-09-25T15:00:30Z',101,true)`,
        [site, client, sample]);

      expect(await getAvailableClientScopes(client)).toEqual([]);
      expect(await backfillPendingRollups(db, site)).toBe(2);
      expect(await backfillPendingRollups(db, site)).toBe(0);
      expect(await getAvailableClientScopes(client)).toEqual(['internet']);
      const before = await getClientTraffic(client, 'internet', new Date('2026-09-25T14:59:30Z'),
        new Date('2026-09-25T15:00:30Z'), db);
      expect(before.downloadBytes).toBe('101');
      expect(before.points.map(point => point.downloadBytes)).toEqual(['50', '51']);
      expect(before.points.map(point => point.downloadObservedSeconds)).toEqual([30, 30]);
      expect(before.boundaryEstimated).toBe(true);
      const hourly = await db.query<{bytes: string}>(`SELECT bytes::text FROM traffic_rollups
        WHERE client_id=$1 AND resolution='1h' ORDER BY bucket_start`, [client]);
      expect(hourly.rows.map(row => row.bytes)).toEqual(['50', '51']);

      await recordQualityRollups(db, site, client, 'internet', 'download', new Date('2026-09-25T15:01:00Z'), 'reset');
      const quality = await db.query<{reset_count: number}>(`SELECT reset_count FROM traffic_rollups
        WHERE client_id=$1 AND resolution='5m' AND bucket_start='2026-09-25T15:00:00Z'`, [client]);
      expect(quality.rows[0].reset_count).toBe(1);

      await db.query(`INSERT INTO settings (id,raw_retention_days,five_minute_retention_days,hourly_retention_days)
        VALUES (1,1,90,365) ON CONFLICT (id) DO UPDATE SET raw_retention_days=1,
          five_minute_retention_days=90,hourly_retention_days=365`);
      expect(await pruneExpiredHistory(db, site, new Date('2026-09-28T00:00:00Z'))).toMatchObject({intervals: 1, samples: 1, rollups: 0});
      const after = await getClientTraffic(client, 'internet', new Date('2026-09-25T14:59:30Z'),
        new Date('2026-09-25T15:00:30Z'), db);
      expect(after.downloadBytes).toBe('101');

      const huge = 9007199254740993n;
      const laterSample = (await db.query<{id: string}>(`INSERT INTO client_samples
        (site_id,client_id,run_id,source,scope,direction,counter_bytes,collected_at,quality)
        VALUES ($1,$2,$3,'test','internet','download',$4,'2026-09-25T16:05:00Z','valid') RETURNING id`,
        [site, client, run, huge.toString()])).rows[0].id;
      await db.query(`INSERT INTO traffic_intervals
        (site_id,client_id,sample_id,source,scope,direction,start_at,end_at,bytes,estimated)
        VALUES ($1,$2,$3,'test','internet','download','2026-09-25T16:00:00Z','2026-09-25T16:05:00Z',$4,true)`,
        [site, client, laterSample, huge.toString()]);
      expect(await backfillPendingRollups(db, site)).toBe(2);
      const longRange = await getClientTraffic(client, 'internet', new Date('2026-09-01T00:00:00Z'),
        new Date('2026-09-26T00:00:00Z'), db);
      expect(longRange.bucketSeconds).toBe(7200);
      expect(longRange.downloadBytes).toBe((101n + huge).toString());
      const overview = await getOverviewTraffic(new Date('2026-09-25T14:55:00Z'),
        new Date('2026-09-25T16:10:00Z'), site);
      expect(overview?.scope).toBe('internet');
      expect(overview?.downloadBytes).toBe((101n + huge).toString());
      expect(overview?.topClients[0]).toMatchObject({id: client, totalBytes: (101n + huge).toString()});
      const aged = await pruneExpiredHistory(db, site, new Date('2026-12-26T00:00:00Z'));
      expect(aged.intervals).toBe(1);
      expect(aged.rollups).toBe(3);
      const retained = await db.query<{resolution: string; count: string}>(`SELECT resolution,count(*)::text AS count
        FROM traffic_rollups WHERE client_id=$1 GROUP BY resolution`, [client]);
      expect(retained.rows).toEqual([{resolution: '1h', count: '3'}]);
      expect((await getClientTraffic(client, 'internet', new Date('2026-09-01T00:00:00Z'),
        new Date('2026-09-26T00:00:00Z'), db)).downloadBytes).toBe((101n + huge).toString());

      const recentBucket = new Date(Math.floor((Date.now() - 300000) / 300000) * 300000);
      await db.query(`INSERT INTO traffic_rollups
        (site_id,client_id,scope,direction,resolution,bucket_start,bytes,observed_seconds,gap_count,reset_count,estimated)
        VALUES ($1,$2,'internet','download','5m',$3,5000000,60,0,0,true)`,
        [site, client, recentBucket]);
      const recent = await getOverviewTraffic(new Date(Date.now() - 86400000), new Date(), site);
      expect(recent?.downloadBytes).toBe('5000000');
      expect(recent?.points[0].downloadObservedSeconds).toBe(300);
      expect(recent?.topClients[0]).toMatchObject({id: client, totalBytes: '5000000'});
    } finally { db.release(); }
  });
});
