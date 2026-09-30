import { getPool } from '@utm/db';
import { UnifiClient, UnifiHttpError, extractInternalClients, parseClientSnapshot, parseConnectedClientSnapshot, parseDeviceSnapshot, unifiConfigFromEnv } from '@utm/unifi';
import type { ClientSnapshot, ConnectedClientSnapshot, DeviceSnapshot } from '@utm/unifi';
import type { PoolClient } from 'pg';
import {pruneExpiredHistory} from './maintenance';
import {parseCounterMappings} from './mapping';
import {backfillPendingRollups} from './rollups';
import {saveCycle} from './storage';
import {AgentSession, agentConfigFromEnv} from './agent';
import {resolveAgentClients} from './agent-ingest';
import {RecordedCycleError, classifyUnifiError} from './errors';

const siteUuid = process.env.UNIFI_SITE_UUID ?? '';
const internalName = process.env.UNIFI_SITE ?? 'default';
const intervalMs = Number(process.env.COLLECT_INTERVAL_MS ?? 30000);
if (!siteUuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteUuid)) throw new Error('UNIFI_SITE_UUID is required');
if (!Number.isSafeInteger(intervalMs) || intervalMs < 10000 || intervalMs > 3600000) throw new Error('Invalid COLLECT_INTERVAL_MS');
const maxGapMs = Math.max(600000, intervalMs * 10);
const unifi = new UnifiClient(unifiConfigFromEnv());
const counterMappings = parseCounterMappings(process.env);
const agentConfig = agentConfigFromEnv(process.env);
// The agent owns measured internet and LAN usage; API counters must not write the same rollups.
if (agentConfig && [counterMappings.wired, counterMappings.wireless].some(m => m?.scope === 'internet' || m?.scope === 'lan')) {
  throw new Error('API counter mappings cannot use the internet or lan scope while UNIFI_AGENT_URL is set');
}
let stopping = false;
let lastMaintenanceAt = 0;
const agentAbort = new AbortController();
const stop = () => { stopping = true; agentAbort.abort(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

function classify(error: unknown): string {
  if (error instanceof RecordedCycleError) return error.code;
  if (error instanceof UnifiHttpError) return `http_${error.status}`;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'fetch_validation_or_database_error';
}

async function recordError(client: PoolClient, dbSiteId: string, startedAt: Date, code: string): Promise<void> {
  await client.query(`WITH failed AS (
    INSERT INTO collector_runs (site_id, started_at, finished_at, status, error_code)
    VALUES ($1,$2,now(),$3,$4) RETURNING id
  ) SELECT pg_notify('utm_collection', id::text) FROM failed`,
    [dbSiteId, startedAt, 'error', code]);
}


async function ensureSite(client: PoolClient): Promise<string> {
  const site = await client.query<{id: string}>(`INSERT INTO sites (unifi_id, internal_name, label) VALUES ($1,$2,$3)
    ON CONFLICT (unifi_id) DO UPDATE SET internal_name=EXCLUDED.internal_name RETURNING id`, [siteUuid, internalName, internalName]);
  return site.rows[0].id;
}

async function fiveMinuteCutoff(client: PoolClient): Promise<Date> {
  const result = await client.query<{days: number}>('SELECT five_minute_retention_days AS days FROM settings WHERE id=1');
  return new Date(Date.now() - (result.rows[0]?.days ?? 90) * 86400000);
}

async function cycle(): Promise<void> {
  const client = await getPool().connect();
  let locked = false;
  const startedAt = new Date();
  try {
    const lock = await client.query<{ok: boolean}>('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok', ['unifi-traffic-monitor', siteUuid]);
    locked = lock.rows[0]?.ok ?? false;
    if (!locked) return;
    const dbSiteId = await ensureSite(client);
    let snapshots: ClientSnapshot[];
    let connected: ConnectedClientSnapshot[];
    let devices: DeviceSnapshot[];
    try {
      const [siteResponse, clientResponse, connectedResponse, deviceResponse] = await Promise.all([
        unifi.getOfficialSites(), unifi.getInternalClients(), unifi.getOfficialConnectedClients(siteUuid), unifi.getOfficialDevices(siteUuid)
      ]);
      const mapped = siteResponse.data.find(row => row.id === siteUuid);
      if (!mapped || mapped.internalReference !== internalName) throw new Error('Site UUID and internal name do not match');
      snapshots = extractInternalClients(clientResponse).map(parseClientSnapshot);
      connected = connectedResponse.data.map(parseConnectedClientSnapshot);
      devices = deviceResponse.data.map(parseDeviceSnapshot);
      if (new Set(snapshots.map(row => row.mac)).size !== snapshots.length) throw new Error('Duplicate client MAC');
      if (new Set(connected.map(row => row.mac)).size !== connected.length) throw new Error('Duplicate connected client MAC');
      if (new Set(devices.map(row => row.mac)).size !== devices.length) throw new Error('Duplicate device MAC');
    } catch (error) {
      const code = classifyUnifiError(error);
      await recordError(client, dbSiteId, startedAt, code);
      throw new RecordedCycleError(code, error);
    }
    const rawCount = await saveCycle(client, dbSiteId, startedAt, snapshots, connected, devices, counterMappings, maxGapMs);
    console.log(`Collection succeeded: ${snapshots.length} clients, ${connected.length} connected, ${devices.length} devices, ${rawCount} raw counters`);
    if (agentConfig) {
      try {
        const resolved = await resolveAgentClients(client, dbSiteId, await fiveMinuteCutoff(client));
        if (resolved) console.log(`Attached gateway agent usage from ${resolved} buckets to newly listed clients`);
      } catch { console.error('Gateway agent client matching failed; will retry next cycle'); }
    }
    try {
      const backfilled = await backfillPendingRollups(client, dbSiteId);
      if (backfilled) console.log(`Backfilled ${backfilled} earlier traffic observations`);
    } catch { console.error('Traffic rollup backfill failed; will retry next cycle'); }
    if (Date.now() - lastMaintenanceAt >= 3600000) {
      try {
        const removed = await pruneExpiredHistory(client, dbSiteId);
        lastMaintenanceAt = Date.now();
        if (removed.intervals || removed.samples || removed.rollups || removed.agentBuckets) {
          console.log(`Pruned ${removed.intervals} intervals, ${removed.samples} samples, ${removed.rollups} rollups, ${removed.agentBuckets} agent buckets`);
        }
      } catch { console.error('History retention failed; will retry next cycle'); }
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', ['unifi-traffic-monitor', siteUuid]).catch(() => {});
    client.release();
  }
}

async function main(): Promise<void> {
  let failures = 0;
  const agentTask = agentConfig ? new AgentSession(agentConfig, getPool(), ensureSite).run(agentAbort.signal)
    .catch(() => console.error('Gateway agent session stopped unexpectedly')) : Promise.resolve();
  if (agentConfig) console.log(`Gateway agent stream enabled at ${agentConfig.url.host}`);
  try {
    while (!stopping) {
      try { await cycle(); failures = 0; }
      catch (error) { failures++; console.error(`Collector cycle failed: ${classify(error)}`); }
      const backoff = failures ? Math.min(300000, intervalMs * 2 ** Math.min(failures, 4)) : intervalMs;
      const delay = backoff + Math.floor(Math.random() * Math.min(5000, backoff / 4));
      if (!stopping) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); process.off('SIGTERM', finish); process.off('SIGINT', finish); resolve(); };
        const timer = setTimeout(finish, delay);
        process.once('SIGTERM', finish);
        process.once('SIGINT', finish);
      });
    }
  } finally {
    agentAbort.abort();
    await agentTask;
    await unifi.close();
    await getPool().end();
  }
}
main().catch(error => { console.error(`Collector stopped: ${classify(error)}`); process.exitCode = 1; });
