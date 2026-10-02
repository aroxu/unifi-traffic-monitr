import {isIP} from 'node:net';
import {calculateDelta, type CounterObservation} from '@utm/metrics';
import {UnifiClient, UnifiHttpError, extractInternalClients, parseClientSnapshot,
  parseConnectedClientSnapshot, unifiConfigFromEnv} from '@utm/unifi';
import type {ClientSnapshot} from '@utm/unifi';
import {counterSessionKey} from './session';

const uuid = process.env.UNIFI_SITE_UUID ?? '';
const targetMac = process.env.MEASURE_CLIENT_MAC?.toLowerCase();
const targetIp = process.env.MEASURE_CLIENT_IP;
const samples = Number(process.env.MEASURE_SAMPLES ?? 12);
const intervalMs = Number(process.env.MEASURE_INTERVAL_MS ?? 20000);
if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(uuid)) throw new Error('UNIFI_SITE_UUID is required');
if (Boolean(targetMac) === Boolean(targetIp) ||
    (targetMac && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(targetMac)) ||
    (targetIp && !isIP(targetIp))) throw new Error('Set exactly one valid MEASURE_CLIENT_MAC or MEASURE_CLIENT_IP');
if (!Number.isSafeInteger(samples) || samples < 2 || samples > 60 ||
    !Number.isSafeInteger(intervalMs) || intervalMs < 5000 || intervalMs > 60000) {
  throw new Error('Invalid measurement sample count or interval');
}

const unifi = new UnifiClient(unifiConfigFromEnv());
const started = Date.now();
const previous = new Map<'rx' | 'tx', CounterObservation>();
const totals = {rx: 0n, tx: 0n};
let resolvedMac = targetMac;
let stopping = false;
process.on('SIGINT', () => {stopping = true;});
process.on('SIGTERM', () => {stopping = true;});

function selectTarget(rows: ClientSnapshot[]): ClientSnapshot | null {
  const matches = rows.filter(row => resolvedMac ? row.mac === resolvedMac : row.ip === targetIp);
  if (matches.length > 1) throw new Error('Target selector is not unique');
  const found = matches[0] ?? null;
  if (found && !resolvedMac) resolvedMac = found.mac;
  return found;
}

async function sample(index: number): Promise<void> {
  const elapsedSeconds = Math.round((Date.now() - started) / 1000);
  try {
    const [internal, connected] = await Promise.all([
      unifi.getInternalClients(), unifi.getOfficialConnectedClients(uuid)
    ]);
    const target = selectTarget(extractInternalClients(internal).map(parseClientSnapshot));
    if (!target) {
      previous.clear();
      console.log(JSON.stringify({sample: index, elapsedSeconds, status: 'target_missing'}));
      return;
    }
    const online = connected.data.map(parseConnectedClientSnapshot).find(row => row?.mac === target.mac);
    if (!online || (online.connection && online.connection !== target.connection)) {
      previous.clear();
      console.log(JSON.stringify({sample: index, elapsedSeconds,
        status: online ? 'connection_mismatch' : 'offline'}));
      return;
    }
    if (target.counters.length !== 2) {
      previous.clear();
      console.log(JSON.stringify({sample: index, elapsedSeconds, status: 'counter_unsupported'}));
      return;
    }
    const now = new Date();
    const readings: Record<string, string | null> = {};
    for (const raw of target.counters) {
      const current: CounterObservation = {value: raw.value, observedAt: now, source: raw.source,
        scope: 'unknown', direction: raw.direction,
        sessionKey: counterSessionKey(raw.sessionKey, target.deviceMac)};
      const delta = calculateDelta(previous.get(raw.direction) ?? null, current,
        Math.max(600000, intervalMs * 10));
      readings[`${raw.direction}Quality`] = delta.quality;
      readings[`${raw.direction}DeltaBytes`] = delta.bytes?.toString() ?? null;
      if (delta.quality === 'valid' && delta.bytes !== null) totals[raw.direction] += delta.bytes;
      if (delta.advanceCheckpoint) previous.set(raw.direction, current);
    }
    console.log(JSON.stringify({sample: index, elapsedSeconds, status: 'ok',
      connection: target.connection, ...readings,
      rxTotalValidBytes: totals.rx.toString(), txTotalValidBytes: totals.tx.toString()}));
  } catch (error) {
    previous.clear();
    const code = error instanceof UnifiHttpError ? `http_${error.status}` :
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'validation_or_network_error';
    console.log(JSON.stringify({sample: index, elapsedSeconds, status: 'error', code}));
  }
}

async function main(): Promise<void> {
  try {
    console.log(JSON.stringify({event: 'measurement_start', samples, intervalSeconds: intervalMs / 1000,
      note: 'Start the controlled transfer after sample 0. rx/tx are raw labels; traffic scope is unverified.'}));
    for (let index = 0; index < samples && !stopping; index++) {
      if (index) await new Promise(resolve => setTimeout(resolve, intervalMs));
      if (!stopping) await sample(index);
    }
    console.log(JSON.stringify({event: 'measurement_end', rxTotalValidBytes: totals.rx.toString(),
      txTotalValidBytes: totals.tx.toString()}));
  } finally {await unifi.close();}
}

main().catch(() => {console.error('Measurement stopped unexpectedly'); process.exitCode = 1;});
