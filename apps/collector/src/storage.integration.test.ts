import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {getPool} from '@utm/db';
import type {ClientSnapshot, ConnectedClientSnapshot} from '@utm/unifi';
import {saveCycle} from './storage';

const mapping = {wired: {scope: 'internet', rxDirection: 'upload'}, wireless: null} as const;
const snapshots = (base: bigint): ClientSnapshot[] => ['00:00:00:00:00:01', '00:00:00:00:00:02'].map((mac, index) => ({
  mac, unifiId: null, name: null, ip: null, connection: 'wired' as const, deviceMac: null, lastSeenAt: null,
  wirelessQuality: null,
  counters: [
    {source: 'sta:wired-rx_bytes', direction: 'rx' as const, value: base + BigInt(index), sessionKey: 'same'},
    {source: 'sta:wired-tx_bytes', direction: 'tx' as const, value: base + BigInt(index), sessionKey: 'same'}
  ]
}));
const connected = (count: number): ConnectedClientSnapshot[] => snapshots(0n).slice(0, count).map(row => ({
  mac: row.mac, unifiId: null, name: null, ip: null, connection: 'wired', uplinkDeviceUnifiId: null
}));

describe.skipIf(process.env.DB_INTEGRATION !== '1')('PostgreSQL connected client reconciliation', () => {
  afterAll(async () => { await getPool().end(); });

  it('rebases counters when official and internal connection types disagree', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`transition-${randomUUID()}`])).rows[0].id;
      const switchDevice = {unifiId: 'switch', mac: '00:00:00:00:00:0a', name: null, model: null, online: true};
      const wired = {...snapshots(100n)[0], deviceMac: switchDevice.mac};
      const officialWired = connected(1)[0];
      const officialWireless = {...officialWired, connection: 'wireless' as const};
      const bothMapped = {wired: {scope: 'internet', rxDirection: 'upload'},
        wireless: {scope: 'internet', rxDirection: 'upload'}} as const;
      expect(await saveCycle(db, site, new Date(), [wired], [officialWired], [switchDevice], bothMapped, 600000)).toBe(2);
      const id = (await db.query<{id: string}>(`SELECT id FROM clients WHERE site_id=$1`, [site])).rows[0].id;
      expect((await db.query<{device_id: string | null}>(`SELECT device_id FROM clients WHERE id=$1`, [id])).rows[0].device_id)
        .not.toBeNull();
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM collector_checkpoints
        WHERE client_id=$1`, [id])).rows[0].count).toBe('2');

      expect(await saveCycle(db, site, new Date(), [snapshots(120n)[0]],
        [officialWireless], [], bothMapped, 600000)).toBe(0);
      expect((await db.query<{connection: string; online: boolean; device_id: string | null}>(
        `SELECT connection,online,device_id FROM clients WHERE id=$1`, [id])).rows[0])
        .toEqual({connection: 'wireless', online: true, device_id: null});
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM collector_checkpoints
        WHERE client_id=$1`, [id])).rows[0].count).toBe('0');
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM client_samples
        WHERE client_id=$1`, [id])).rows[0].count).toBe('2');

      const wireless: ClientSnapshot = {...wired, connection: 'wireless', wirelessQuality: null,
        counters: [
          {source: 'sta:rx_bytes', direction: 'rx', value: 300n, sessionKey: 'new'},
          {source: 'sta:tx_bytes', direction: 'tx', value: 300n, sessionKey: 'new'}
        ]};
      expect(await saveCycle(db, site, new Date(), [wireless], [officialWireless], [], bothMapped, 600000)).toBe(2);
      const qualities = await db.query<{quality: string}>(`SELECT s.quality FROM client_samples s
        JOIN collector_runs r ON r.id=s.run_id WHERE s.client_id=$1 ORDER BY r.started_at DESC LIMIT 2`, [id]);
      expect(qualities.rows.map(row => row.quality)).toEqual(['baseline', 'baseline']);
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM traffic_intervals
        WHERE client_id=$1`, [id])).rows[0].count).toBe('0');
      await new Promise(resolve => setTimeout(resolve, 5));
      await saveCycle(db, site, new Date(), [{...wireless, counters: wireless.counters.map(counter =>
        ({...counter, value: 320n}))}], [officialWireless], [], bothMapped, 600000);
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM traffic_intervals
        WHERE client_id=$1`, [id])).rows[0].count).toBe('2');
    } finally { db.release(); }
  });

  it('stores current wireless readings and clears them when coverage or connection disappears', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`wireless-${randomUUID()}`])).rows[0].id;
      const wireless: ClientSnapshot = {mac: '00:00:00:00:00:03', unifiId: null, name: null, ip: null,
        connection: 'wireless', deviceMac: null, lastSeenAt: null,
        wirelessQuality: {signalDbm: -67, noiseDbm: -96}, counters: []};
      const online: ConnectedClientSnapshot = {mac: wireless.mac, unifiId: null, name: null, ip: null,
        connection: 'wireless', uplinkDeviceUnifiId: null};
      await saveCycle(db, site, new Date(), [wireless], [online], [], mapping, 600000);
      const stored = (await db.query<{online: boolean; wireless_signal_dbm: number | null;
        wireless_noise_dbm: number | null; wireless_observed_at: Date | null}>(
        `SELECT online,wireless_signal_dbm,wireless_noise_dbm,wireless_observed_at
         FROM clients WHERE site_id=$1`, [site])).rows[0];
      expect(stored).toMatchObject({online: true, wireless_signal_dbm: -67, wireless_noise_dbm: -96});
      expect(stored.wireless_observed_at).toBeInstanceOf(Date);

      await saveCycle(db, site, new Date(), [], [online], [], mapping, 600000);
      expect((await db.query(`SELECT wireless_signal_dbm,wireless_noise_dbm,wireless_observed_at
        FROM clients WHERE site_id=$1`, [site])).rows[0]).toEqual({
        wireless_signal_dbm: null, wireless_noise_dbm: null, wireless_observed_at: null});

      await saveCycle(db, site, new Date(), [wireless], [], [], mapping, 600000);
      expect((await db.query(`SELECT online,wireless_signal_dbm,wireless_noise_dbm,wireless_observed_at
        FROM clients WHERE site_id=$1`, [site])).rows[0]).toEqual({
        online: false, wireless_signal_dbm: null, wireless_noise_dbm: null, wireless_observed_at: null});
    } finally { db.release(); }
  });

  it('keeps stale internal clients offline and rebases after reconnect', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`presence-${randomUUID()}`])).rows[0].id;
      expect(await saveCycle(db, site, new Date(), snapshots(100n), connected(2), [], mapping, 600000)).toBe(4);
      const id = (await db.query<{id: string}>(`SELECT id FROM clients WHERE site_id=$1 AND mac='00:00:00:00:00:02'`, [site])).rows[0].id;
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM collector_checkpoints WHERE client_id=$1`, [id])).rows[0].count).toBe('2');

      expect(await saveCycle(db, site, new Date(), snapshots(120n), connected(1), [], mapping, 600000)).toBe(2);
      expect((await db.query<{online: boolean}>(`SELECT online FROM clients WHERE id=$1`, [id])).rows[0].online).toBe(false);
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM collector_checkpoints WHERE client_id=$1`, [id])).rows[0].count).toBe('0');
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM client_samples WHERE client_id=$1`, [id])).rows[0].count).toBe('2');

      expect(await saveCycle(db, site, new Date(), snapshots(140n), connected(2), [], mapping, 600000)).toBe(4);
      expect((await db.query<{quality: string}>(`SELECT quality FROM client_samples WHERE client_id=$1 ORDER BY collected_at DESC LIMIT 1`, [id])).rows[0].quality).toBe('baseline');
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM traffic_intervals WHERE client_id=$1`, [id])).rows[0].count).toBe('0');

      expect(await saveCycle(db, site, new Date(), snapshots(145n), connected(2), [], mapping, 600000)).toBe(4);
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM traffic_intervals WHERE client_id=$1`, [id])).rows[0].count).toBe('2');
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM collector_runs WHERE site_id=$1 AND status='measured'`, [site])).rows[0].count).toBe('3');
    } finally { db.release(); }
  });

  it('marks a client absent from both complete lists offline immediately and rebases on quick reconnect', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`quick-reconnect-${randomUUID()}`])).rows[0].id;
      const first = snapshots(100n)[0];
      const online = connected(1)[0];
      await saveCycle(db, site, new Date(), [first], [online], [], mapping, 600000);
      const id = (await db.query<{id: string}>(`SELECT id FROM clients WHERE site_id=$1`, [site])).rows[0].id;
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count
        FROM collector_checkpoints WHERE client_id=$1`, [id])).rows[0].count).toBe('2');

      await saveCycle(db, site, new Date(), [], [], [], mapping, 600000);
      expect((await db.query<{online: boolean}>(`SELECT online FROM clients WHERE id=$1`, [id])).rows[0].online).toBe(false);
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count
        FROM collector_checkpoints WHERE client_id=$1`, [id])).rows[0].count).toBe('0');

      await saveCycle(db, site, new Date(), [{...first, counters: first.counters.map(raw =>
        ({...raw, value: 120n}))}], [online], [], mapping, 600000);
      expect((await db.query<{quality: string}>(`SELECT quality FROM client_samples
        WHERE client_id=$1 ORDER BY collected_at DESC LIMIT 2`, [id])).rows.map(row => row.quality))
        .toEqual(['baseline', 'baseline']);
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM traffic_intervals
        WHERE client_id=$1`, [id])).rows[0].count).toBe('0');

      await new Promise(resolve => setTimeout(resolve, 5));
      await saveCycle(db, site, new Date(), [{...first, counters: first.counters.map(raw =>
        ({...raw, value: 130n}))}], [online], [], mapping, 600000);
      expect((await db.query<{count: string; bytes: string}>(`SELECT count(*)::text AS count,
        coalesce(sum(bytes),0)::text AS bytes FROM traffic_intervals WHERE client_id=$1`, [id])).rows[0])
        .toEqual({count: '2', bytes: '20'});
    } finally { db.release(); }
  });

  it('rebases wireless counters when the access point changes without a new association timestamp', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`roam-${randomUUID()}`])).rows[0].id;
      const apA = {unifiId: 'ap-a', mac: '00:00:00:00:00:0a', name: null, model: null, online: true};
      const apB = {unifiId: 'ap-b', mac: '00:00:00:00:00:0b', name: null, model: null, online: true};
      const wireless = (value: bigint, deviceMac: string): ClientSnapshot => ({
        mac: '00:00:00:00:00:03', unifiId: null, name: null, ip: null, connection: 'wireless',
        deviceMac, lastSeenAt: null, wirelessQuality: null,
        counters: [
          {source: 'sta:rx_bytes', direction: 'rx', value, sessionKey: 'same-association'},
          {source: 'sta:tx_bytes', direction: 'tx', value, sessionKey: 'same-association'}
        ]
      });
      const online: ConnectedClientSnapshot = {mac: wireless(100n, apA.mac).mac, unifiId: null,
        name: null, ip: null, connection: 'wireless', uplinkDeviceUnifiId: apA.unifiId};
      const wirelessMapping = {wired: null, wireless: {scope: 'internet', rxDirection: 'upload'}} as const;
      await saveCycle(db, site, new Date(), [wireless(100n, apA.mac)], [online], [apA, apB], wirelessMapping, 600000);
      await new Promise(resolve => setTimeout(resolve, 5));
      await saveCycle(db, site, new Date(), [wireless(120n, apA.mac)], [online], [apA, apB], wirelessMapping, 600000);
      const before = await db.query<{count: string; bytes: string}>(`SELECT count(*)::text AS count,
        coalesce(sum(bytes),0)::text AS bytes FROM traffic_intervals WHERE site_id=$1`, [site]);
      expect(before.rows[0]).toEqual({count: '2', bytes: '40'});

      await new Promise(resolve => setTimeout(resolve, 5));
      await saveCycle(db, site, new Date(), [wireless(140n, apB.mac)],
        [{...online, uplinkDeviceUnifiId: apB.unifiId}], [apA, apB], wirelessMapping, 600000);
      const roamed = await db.query<{quality: string; session_key: string | null}>(`SELECT quality,session_key
        FROM client_samples WHERE run_id=(SELECT id FROM collector_runs WHERE site_id=$1
          ORDER BY started_at DESC LIMIT 1)`, [site]);
      expect(roamed.rows).toHaveLength(2);
      expect(roamed.rows.every(row => row.quality === 'baseline')).toBe(true);
      expect(roamed.rows.every(row => row.session_key?.includes(apB.mac))).toBe(true);
      const afterRoam = await db.query<{count: string; bytes: string}>(`SELECT count(*)::text AS count,
        coalesce(sum(bytes),0)::text AS bytes FROM traffic_intervals WHERE site_id=$1`, [site]);
      expect(afterRoam.rows[0]).toEqual({count: '2', bytes: '40'});

      await new Promise(resolve => setTimeout(resolve, 5));
      await saveCycle(db, site, new Date(), [wireless(150n, apB.mac)],
        [{...online, uplinkDeviceUnifiId: apB.unifiId}], [apA, apB], wirelessMapping, 600000);
      const resumed = await db.query<{count: string; bytes: string}>(`SELECT count(*)::text AS count,
        coalesce(sum(bytes),0)::text AS bytes FROM traffic_intervals WHERE site_id=$1`, [site]);
      expect(resumed.rows[0]).toEqual({count: '4', bytes: '60'});
    } finally { db.release(); }
  });

  it('records a failed transaction without retaining partial client or counter data', async () => {
    const db = await getPool().connect();
    try {
      const site = (await db.query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`failure-${randomUUID()}`])).rows[0].id;
      await expect(saveCycle(db, site, new Date(), snapshots(9223372036854775808n).slice(0, 1),
        connected(1), [], mapping, 600000)).rejects.toThrow();
      const counts = await db.query<{clients: string; samples: string; checkpoints: string; intervals: string}>(`SELECT
        (SELECT count(*)::text FROM clients WHERE site_id=$1) AS clients,
        (SELECT count(*)::text FROM client_samples WHERE site_id=$1) AS samples,
        (SELECT count(*)::text FROM collector_checkpoints WHERE site_id=$1) AS checkpoints,
        (SELECT count(*)::text FROM traffic_intervals WHERE site_id=$1) AS intervals`, [site]);
      expect(counts.rows[0]).toEqual({clients: '0', samples: '0', checkpoints: '0', intervals: '0'});
      const runs = await db.query<{status: string; error_code: string | null}>(`SELECT status,error_code FROM collector_runs
        WHERE site_id=$1 ORDER BY started_at`, [site]);
      expect(runs.rows).toEqual([{status: 'error', error_code: 'db_write_failed'}]);
      expect(await saveCycle(db, site, new Date(), snapshots(100n).slice(0, 1), connected(1), [], mapping, 600000)).toBe(2);
      expect((await db.query<{count: string}>(`SELECT count(*)::text AS count FROM collector_checkpoints WHERE site_id=$1`, [site])).rows[0].count).toBe('2');
    } finally { db.release(); }
  });
});
