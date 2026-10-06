import {calculateDelta, type CounterDelta, type CounterObservation, type Direction, type TrafficScope} from '@utm/metrics';
import type {ClientSnapshot, ConnectedClientSnapshot, DeviceSnapshot} from '@utm/unifi';
import type {PoolClient} from 'pg';
import {resolvedCounterSemantics, type CounterMappings} from './mapping';
import {RollupBatch} from './rollups';
import {counterSessionKey} from './session';

type Observation = {clientId: string; source: string; scope: TrafficScope; direction: Direction;
  sessionKey: string | null; value: bigint; collectedAt: Date; delta: CounterDelta};
const counterKey = (...parts: string[]) => JSON.stringify(parts);

/**
 * Stores one collection in a single transaction. Each table gets one
 * statement per cycle instead of one per counter, because a site has
 * hundreds of counters and every round trip adds latency.
 */
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
    // The official list holds every adopted device, online or not. A device
    // missing from it was removed from the controller.
    await client.query(`UPDATE devices SET online=false WHERE site_id=$1 AND online IS DISTINCT FROM false
      AND unifi_id <> ALL($2::text[])`, [dbSiteId, devices.map(device => device.unifiId)]);
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
    // The internal row can lag a wired/wireless transition. Use the official
    // connection state below and rebase counters once both sources agree.
    const kept = snapshots.filter(snapshot => !mismatched.has(snapshot.mac));
    const clientIds = new Map<string, string>();
    if (kept.length) {
      const wireless = kept.map(snapshot => connectedMacs.has(snapshot.mac) ? snapshot.wirelessQuality : null);
      const stored = await client.query<{id: string; mac: string}>(`INSERT INTO clients
        (site_id, mac, unifi_id, name, ip, connection, device_id, online, last_seen_at,
         wireless_signal_dbm, wireless_noise_dbm, wireless_observed_at, updated_at)
        SELECT $1, v.mac, v.unifi_id, v.name, v.ip, v.connection, v.device_id, v.online, v.last_seen_at,
          v.signal, v.noise, v.observed_at, now()
        FROM unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::uuid[],$8::bool[],$9::timestamptz[],
          $10::int[],$11::int[],$12::timestamptz[])
          AS v(mac,unifi_id,name,ip,connection,device_id,online,last_seen_at,signal,noise,observed_at)
        ON CONFLICT (site_id, mac)
        DO UPDATE SET unifi_id=EXCLUDED.unifi_id, name=EXCLUDED.name, ip=EXCLUDED.ip,
        connection=EXCLUDED.connection, device_id=EXCLUDED.device_id, online=EXCLUDED.online,
        last_seen_at=COALESCE(EXCLUDED.last_seen_at, clients.last_seen_at),
        wireless_signal_dbm=EXCLUDED.wireless_signal_dbm,
        wireless_noise_dbm=EXCLUDED.wireless_noise_dbm,
        wireless_observed_at=EXCLUDED.wireless_observed_at, updated_at=now() RETURNING id, mac`,
        [dbSiteId, kept.map(row => row.mac), kept.map(row => row.unifiId), kept.map(row => row.name),
          kept.map(row => row.ip), kept.map(row => row.connection),
          kept.map(row => row.deviceMac ? deviceIds.get(row.deviceMac) ?? null : null),
          kept.map(row => connectedMacs.has(row.mac)), kept.map(row => row.lastSeenAt),
          wireless.map(row => row?.signalDbm ?? null), wireless.map(row => row?.noiseDbm ?? null),
          wireless.map(row => row && (row.signalDbm !== null || row.noiseDbm !== null) ? startedAt : null)]);
      for (const row of stored.rows) clientIds.set(row.mac, row.id);
    }
    const counted = kept.filter(snapshot => connectedMacs.has(snapshot.mac) && snapshot.counters.length);
    const checkpoints = new Map<string, {value: string; observed_at: Date; session_key: string | null}>();
    if (counted.length) {
      const prior = await client.query<{client_id: string; source: string; scope: string; direction: string;
        value: string; observed_at: Date; session_key: string | null}>(`SELECT client_id, source, scope, direction,
        value, observed_at, session_key FROM collector_checkpoints WHERE client_id = ANY($1::uuid[]) FOR UPDATE`,
        [counted.map(snapshot => clientIds.get(snapshot.mac)!)]);
      for (const row of prior.rows) checkpoints.set(counterKey(row.client_id, row.source, row.scope, row.direction), row);
    }
    const observations: Observation[] = [];
    for (const snapshot of counted) {
      const clientId = clientIds.get(snapshot.mac)!;
      for (const raw of snapshot.counters) {
        const collectedAt = new Date(); // The source has no timestamp for these cumulative fields.
        const sessionKey = counterSessionKey(raw.sessionKey, snapshot.deviceMac);
        const semantics = resolvedCounterSemantics(counterMappings, snapshot.connection, raw.direction);
        const prior = checkpoints.get(counterKey(clientId, raw.source, semantics.scope, semantics.direction));
        const current: CounterObservation = {value: raw.value, observedAt: collectedAt, source: raw.source,
          ...semantics, sessionKey};
        const previous: CounterObservation | null = prior ? {...current,
          value: BigInt(prior.value), observedAt: prior.observed_at, sessionKey: prior.session_key} : null;
        observations.push({clientId, source: raw.source, ...semantics, sessionKey, value: raw.value, collectedAt,
          delta: calculateDelta(previous, current, maxGapMs)});
      }
    }
    let measuredIntervals = 0;
    if (observations.length) {
      const samples = await client.query<{id: string; client_id: string; source: string; direction: string}>(`INSERT INTO client_samples
        (site_id, client_id, run_id, source, scope, direction, session_key, counter_bytes, observed_at, collected_at, quality, rollup_applied)
        SELECT $1, v.client_id, $2, v.source, v.scope, v.direction, v.session_key, v.counter_bytes, NULL, v.collected_at, v.quality, true
        FROM unnest($3::uuid[],$4::text[],$5::text[],$6::text[],$7::text[],$8::bigint[],$9::timestamptz[],$10::text[])
          AS v(client_id,source,scope,direction,session_key,counter_bytes,collected_at,quality)
        RETURNING id, client_id, source, direction`,
        [dbSiteId, runId, observations.map(row => row.clientId), observations.map(row => row.source),
          observations.map(row => row.scope), observations.map(row => row.direction), observations.map(row => row.sessionKey),
          observations.map(row => row.value.toString()), observations.map(row => row.collectedAt),
          observations.map(row => row.delta.quality)]);
      // A run has one sample per client, source and direction.
      const sampleIds = new Map(samples.rows.map(row => [counterKey(row.client_id, row.source, row.direction), row.id]));
      const advanced = observations.filter(row => row.delta.advanceCheckpoint);
      if (advanced.length) await client.query(`INSERT INTO collector_checkpoints
        (site_id, client_id, source, scope, direction, session_key, value, observed_at)
        SELECT $1, v.client_id, v.source, v.scope, v.direction, v.session_key, v.value, v.observed_at
        FROM unnest($2::uuid[],$3::text[],$4::text[],$5::text[],$6::text[],$7::bigint[],$8::timestamptz[])
          AS v(client_id,source,scope,direction,session_key,value,observed_at)
        ON CONFLICT (client_id, source, scope, direction) DO UPDATE SET
        session_key=EXCLUDED.session_key, value=EXCLUDED.value, observed_at=EXCLUDED.observed_at`,
        [dbSiteId, advanced.map(row => row.clientId), advanced.map(row => row.source), advanced.map(row => row.scope),
          advanced.map(row => row.direction), advanced.map(row => row.sessionKey), advanced.map(row => row.value.toString()),
          advanced.map(row => row.collectedAt)]);
      const rollups = new RollupBatch();
      const intervals: {row: Observation; sampleId: string; start: Date; bytes: bigint}[] = [];
      for (const row of observations) {
        const {scope, direction, delta} = row;
        if (scope === 'unknown' || (direction !== 'upload' && direction !== 'download')) continue;
        if (delta.quality === 'valid' && delta.bytes !== null && delta.start) {
          intervals.push({row, sampleId: sampleIds.get(counterKey(row.clientId, row.source, direction))!,
            start: delta.start, bytes: delta.bytes});
          rollups.addInterval(row.clientId, scope, direction, delta.start, delta.end, delta.bytes, true);
        } else if (delta.quality === 'gap' || delta.quality === 'reset') {
          rollups.addQuality(row.clientId, scope, direction, row.collectedAt, delta.quality);
        }
      }
      if (intervals.length) await client.query(`INSERT INTO traffic_intervals
        (site_id, client_id, sample_id, source, scope, direction, start_at, end_at, bytes, estimated, rollup_applied)
        SELECT $1, v.client_id, v.sample_id, v.source, v.scope, v.direction, v.start_at, v.end_at, v.bytes, true, true
        FROM unnest($2::uuid[],$3::uuid[],$4::text[],$5::text[],$6::text[],$7::timestamptz[],$8::timestamptz[],$9::bigint[])
          AS v(client_id,sample_id,source,scope,direction,start_at,end_at,bytes)`,
        [dbSiteId, intervals.map(item => item.row.clientId), intervals.map(item => item.sampleId),
          intervals.map(item => item.row.source), intervals.map(item => item.row.scope), intervals.map(item => item.row.direction),
          intervals.map(item => item.start), intervals.map(item => item.row.delta.end), intervals.map(item => item.bytes.toString())]);
      await rollups.write(client, dbSiteId);
      measuredIntervals = intervals.length;
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
