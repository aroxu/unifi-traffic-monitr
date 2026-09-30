import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {getPool} from '@utm/db';
import {agentResumePoint, ingestAgentBuckets, resolveAgentClients} from './agent-ingest';
import type {AgentBucket} from './agent-protocol';

const mac = '02:00:00:00:00:01';
const later = '02:00:00:00:00:02';
const bucket = (start: string, final: boolean, coverage: number, down: bigint, extra = false): AgentBucket => ({
  start: new Date(start), final, coverageSeconds: coverage, subjects: [
    {mac, internet: {up: 10n, down}, lan: {up: 1n, down: 2n}},
    ...(extra ? [{mac: later, internet: {up: 5n, down: 7n}, lan: {up: 0n, down: 0n}}] : [])]});

describe.skipIf(process.env.DB_INTEGRATION !== '1')('gateway agent ingest', () => {
  afterAll(async () => { await getPool().end(); });

  it('replaces partial values, rebuilds hours, and attaches late clients', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`agent-${randomUUID()}`])).rows[0].id;
      const client = (await db.query<{id: string}>(`INSERT INTO clients (site_id,mac,online) VALUES ($1,$2,true)
        RETURNING id`, [site, mac])).rows[0].id;
      const rollup = async (resolution: string, start: string, scope = 'internet', direction = 'download', id = client) =>
        (await db.query<{bytes: string; observed_seconds: number; gap_count: number}>(`SELECT bytes::text, observed_seconds, gap_count
          FROM traffic_rollups WHERE client_id=$1 AND scope=$2 AND direction=$3 AND resolution=$4 AND bucket_start=$5`,
          [id, scope, direction, resolution, new Date(start)])).rows[0];

      await ingestAgentBuckets(db, site, [bucket('2026-09-30T03:00:00Z', false, 120, 1000n)]);
      expect(await rollup('5m', '2026-09-30T03:00:00Z')).toEqual({bytes: '1000', observed_seconds: 120, gap_count: 0});
      await ingestAgentBuckets(db, site, [bucket('2026-09-30T03:00:00Z', true, 300, 1500n, true)]);
      expect(await rollup('5m', '2026-09-30T03:00:00Z')).toEqual({bytes: '1500', observed_seconds: 300, gap_count: 0});
      // A late partial must not overwrite the final value.
      await ingestAgentBuckets(db, site, [bucket('2026-09-30T03:00:00Z', false, 60, 9n)]);
      expect((await rollup('5m', '2026-09-30T03:00:00Z')).bytes).toBe('1500');

      const batch = [bucket('2026-09-30T03:05:00Z', true, 200, 500n), bucket('2026-09-30T04:00:00Z', true, 300, 42n)];
      await ingestAgentBuckets(db, site, batch);
      await ingestAgentBuckets(db, site, batch); // replay is idempotent
      expect(await rollup('1h', '2026-09-30T03:00:00Z')).toEqual({bytes: '2000', observed_seconds: 500, gap_count: 1});
      expect(await rollup('1h', '2026-09-30T04:00:00Z')).toEqual({bytes: '42', observed_seconds: 300, gap_count: 0});
      expect((await rollup('1h', '2026-09-30T03:00:00Z', 'lan', 'upload')).bytes).toBe('2');
      expect((await agentResumePoint(db, site))?.toISOString()).toBe('2026-09-30T04:00:00.000Z');

      const pending = await db.query<{count: string}>(`SELECT count(*)::text AS count FROM agent_buckets
        WHERE site_id=$1 AND subject=$2 AND client_id IS NULL`, [site, later]);
      expect(pending.rows[0].count).toBe('4');
      const lateClient = (await db.query<{id: string}>(`INSERT INTO clients (site_id,mac,online) VALUES ($1,$2,true)
        RETURNING id`, [site, later])).rows[0].id;
      expect(await resolveAgentClients(db, site, new Date('2026-09-30T02:10:00Z'))).toBe(1);
      expect((await rollup('5m', '2026-09-30T03:00:00Z', 'internet', 'download', lateClient)).bytes).toBe('7');
      expect((await rollup('1h', '2026-09-30T03:00:00Z', 'internet', 'upload', lateClient)).bytes).toBe('5');
      // The first client's hour is rebuilt to the same total.
      expect((await rollup('1h', '2026-09-30T03:00:00Z')).bytes).toBe('2000');
    } finally {
      db.release();
    }
  });
});
