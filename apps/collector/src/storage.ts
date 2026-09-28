import {calculateDelta, type CounterObservation} from '@utm/metrics';
import type {ClientSnapshot, ConnectedClientSnapshot, DeviceSnapshot} from '@utm/unifi';
import type {PoolClient} from 'pg';
import {resolvedCounterSemantics, type CounterMappings} from './mapping';
import {recordIntervalRollups, recordQualityRollups} from './rollups';
import {counterSessionKey} from './session';

export async function saveCycle(client: PoolClient, dbSiteId: string, startedAt: Date, snapshots: ClientSnapshot[], connected: ConnectedClientSnapshot[], devices: DeviceSnapshot[], counterMappings: CounterMappings, maxGapMs: number): Promise<number> {
  await client.query('BEGIN');
  try {
    const deviceIds = new Map<string, string>();
    const deviceIdsByUnifi = new Map<string, string>();
    for (const device of devices) {
      const result = await client.query<{id: string}>(`INSERT INTO devices (site_id, unifi_id, name, model, online, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,CASE WHEN $5 THEN $6::timestamptz ELSE NULL END)
        ON CONFLICT (site_id, unifi_id) DO UPDATE SET name=EXCLUDED.name, model=EXCLUDED.model,
        online=EXCLUDED.online, last_seen_at=COALESCE(EXCLUDED.last_seen_at, devices.last_seen_at) RETURNING id`,
        [dbSiteId, device.unifiId, device.name, device.model, device.online, startedAt]);
      deviceIds.set(device.mac, result.rows[0].id);
      deviceIdsByUnifi.set(device.unifiId, result.rows[0].id);
    }
    const activeMacs = [...new Set(connected.map(row => row.mac))];
    const connectedMacs = new Set(activeMacs);
    const connectionByMac = new Map(connected.map(row => [row.mac, row.connection]));
    const mismatchedMacs = snapshots.filter(snapshot => {
      const official = connectionByMac.get(snapshot.mac);
      return official !== undefined && official !== null && official !== snapshot.connection;
    }).map(snapshot => snapshot.mac);
    const mismatched = new Set(mismatchedMacs);
    const rawCount = snapshots.reduce((sum, snapshot) =>
      sum + (connectedMacs.has(snapshot.mac) && !mismatched.has(snapshot.mac) ? snapshot.counters.length : 0), 0);
    const run = await client.query<{id: string}>(`INSERT INTO collector_runs
      (site_id, started_at, finished_at, status, client_count) VALUES ($1,$2,now(),$3,$4) RETURNING id`,
      [dbSiteId, startedAt, rawCount ? 'raw_only' : 'identity_only', activeMacs.length]);
    const runId = run.rows[0].id;
    let measuredIntervals = 0;
    for (const snapshot of snapshots) {
      // The internal row can lag a wired/wireless transition. Use the official
      // connection state below and rebase counters once both sources agree.
      if (mismatched.has(snapshot.mac)) continue;
      const isConnected = connectedMacs.has(snapshot.mac);
      const wireless = isConnected ? snapshot.wirelessQuality : null;
      const clientResult = await client.query<{id: string}>(`INSERT INTO clients
        (site_id, mac, unifi_id, name, ip, connection, device_id, online, last_seen_at,
         wireless_signal_dbm, wireless_noise_dbm, wireless_observed_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) ON CONFLICT (site_id, mac)
        DO UPDATE SET unifi_id=EXCLUDED.unifi_id, name=EXCLUDED.name, ip=EXCLUDED.ip,
        connection=EXCLUDED.connection, device_id=EXCLUDED.device_id, online=EXCLUDED.online,
        last_seen_at=COALESCE(EXCLUDED.last_seen_at, clients.last_seen_at),
        wireless_signal_dbm=EXCLUDED.wireless_signal_dbm,
        wireless_noise_dbm=EXCLUDED.wireless_noise_dbm,
        wireless_observed_at=EXCLUDED.wireless_observed_at, updated_at=now() RETURNING id`,
        [dbSiteId, snapshot.mac, snapshot.unifiId, snapshot.name, snapshot.ip, snapshot.connection,
          snapshot.deviceMac ? deviceIds.get(snapshot.deviceMac) ?? null : null, isConnected, snapshot.lastSeenAt,
          wireless?.signalDbm ?? null, wireless?.noiseDbm ?? null,
          wireless && (wireless.signalDbm !== null || wireless.noiseDbm !== null) ? startedAt : null]);
      const clientId = clientResult.rows[0].id;
      if (!isConnected) continue;
      for (const raw of snapshot.counters) {
        const collectedAt = new Date(); // The source has no timestamp for these cumulative fields.
        const sessionKey = counterSessionKey(raw.sessionKey, snapshot.deviceMac);
        const semantics = resolvedCounterSemantics(counterMappings, snapshot.connection, raw.direction);
        const prior = await client.query<{value: string; observed_at: Date; session_key: string | null}>(`SELECT value, observed_at, session_key
          FROM collector_checkpoints WHERE client_id=$1 AND source=$2 AND scope=$3 AND direction=$4 FOR UPDATE`,
          [clientId, raw.source, semantics.scope, semantics.direction]);
        const current: CounterObservation = {value: raw.value, observedAt: collectedAt, source: raw.source,
          ...semantics, sessionKey};
        const previous: CounterObservation | null = prior.rowCount ? {...current,
          value: BigInt(prior.rows[0].value), observedAt: prior.rows[0].observed_at, sessionKey: prior.rows[0].session_key} : null;
        const delta = calculateDelta(previous, current, maxGapMs);
        const sample = await client.query<{id: string}>(`INSERT INTO client_samples
          (site_id, client_id, run_id, source, scope, direction, session_key, counter_bytes, observed_at, collected_at, quality, rollup_applied)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,true) RETURNING id`,
          [dbSiteId, clientId, runId, raw.source, semantics.scope, semantics.direction,
            sessionKey, raw.value.toString(), collectedAt, delta.quality]);
        if (delta.advanceCheckpoint) await client.query(`INSERT INTO collector_checkpoints
          (site_id, client_id, source, scope, direction, session_key, value, observed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (client_id, source, scope, direction) DO UPDATE SET
          session_key=EXCLUDED.session_key, value=EXCLUDED.value, observed_at=EXCLUDED.observed_at`,
          [dbSiteId, clientId, raw.source, semantics.scope, semantics.direction,
            sessionKey, raw.value.toString(), collectedAt]);
        if (semantics.scope !== 'unknown' && (semantics.direction === 'upload' || semantics.direction === 'download') &&
            delta.quality === 'valid' && delta.bytes !== null && delta.start) {
          await client.query(`INSERT INTO traffic_intervals
            (site_id, client_id, sample_id, source, scope, direction, start_at, end_at, bytes, estimated, rollup_applied)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,true)`,
            [dbSiteId, clientId, sample.rows[0].id, raw.source, semantics.scope, semantics.direction,
              delta.start, delta.end, delta.bytes.toString()]);
          await recordIntervalRollups(client, dbSiteId, clientId, semantics.scope, semantics.direction,
            delta.start, delta.end, delta.bytes, true);
          measuredIntervals++;
        } else if (semantics.scope !== 'unknown' && (semantics.direction === 'upload' || semantics.direction === 'download') &&
                   (delta.quality === 'gap' || delta.quality === 'reset')) {
          await recordQualityRollups(client, dbSiteId, clientId, semantics.scope, semantics.direction,
            collectedAt, delta.quality);
        }
      }
    }
    const snapshotMacs = new Set(snapshots.filter(row => !mismatched.has(row.mac)).map(row => row.mac));
    for (const extra of connected) {
      if (snapshotMacs.has(extra.mac)) continue;
      await client.query(`INSERT INTO clients
        (site_id, mac, unifi_id, name, ip, connection, device_id, online, last_seen_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,now()) ON CONFLICT (site_id, mac)
        DO UPDATE SET unifi_id=COALESCE(EXCLUDED.unifi_id, clients.unifi_id),
        name=COALESCE(EXCLUDED.name, clients.name), ip=COALESCE(EXCLUDED.ip, clients.ip),
        connection=COALESCE(EXCLUDED.connection, clients.connection),
        device_id=CASE WHEN $9 OR (EXCLUDED.connection IS NOT NULL AND clients.connection IS DISTINCT FROM EXCLUDED.connection)
          THEN EXCLUDED.device_id ELSE COALESCE(EXCLUDED.device_id, clients.device_id) END, online=true,
        last_seen_at=EXCLUDED.last_seen_at, wireless_signal_dbm=NULL,
        wireless_noise_dbm=NULL, wireless_observed_at=NULL, updated_at=now()`,
        [dbSiteId, extra.mac, extra.unifiId, extra.name, extra.ip, extra.connection,
          extra.uplinkDeviceUnifiId ? deviceIdsByUnifi.get(extra.uplinkDeviceUnifiId) ?? null : null,
          startedAt, mismatched.has(extra.mac)]);
    }
    if (mismatchedMacs.length) await client.query(`DELETE FROM collector_checkpoints cp USING clients c
      WHERE cp.client_id=c.id AND c.site_id=$1 AND c.mac=ANY($2::text[])`, [dbSiteId, mismatchedMacs]);
    await client.query(`UPDATE clients SET online=false, wireless_signal_dbm=NULL,
      wireless_noise_dbm=NULL, wireless_observed_at=NULL, updated_at=now()
      WHERE site_id=$1 AND online IS DISTINCT FROM false AND mac <> ALL($2::text[])`, [dbSiteId, activeMacs]);
    await client.query(`DELETE FROM collector_checkpoints cp USING clients c
      WHERE cp.client_id=c.id AND c.site_id=$1 AND c.online=false`, [dbSiteId]);
    if (measuredIntervals > 0) await client.query(`UPDATE collector_runs SET status='measured' WHERE id=$1`, [runId]);
    await client.query(`SELECT pg_notify('utm_collection', $1)`, [runId]);
    await client.query('COMMIT');
    return rawCount;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`WITH failed AS (
      INSERT INTO collector_runs (site_id,started_at,finished_at,status,error_code)
      VALUES ($1,$2,now(),'error','db_write_failed') RETURNING id
    ) SELECT pg_notify('utm_collection', id::text) FROM failed`, [dbSiteId, startedAt]).catch(() => {});
    throw error;
  }
}
