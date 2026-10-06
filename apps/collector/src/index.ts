import { getPool, withClient } from '@utm/db';
import { UnifiClient, UnifiHttpError, UnifiResponseError, extractInternalClients, parseClientSnapshot, parseConnectedClientSnapshot, parseDeviceSnapshot, unifiConfigFromEnv } from '@utm/unifi';
import type { ClientSnapshot, ConnectedClientSnapshot, DeviceSnapshot } from '@utm/unifi';
import type { PoolClient } from 'pg';
import {currentAgentLedgerCutoff, pruneExpiredHistory} from './maintenance';
import {parseCounterMappings} from './mapping';
import {backfillPendingRollups} from './rollups';
import {saveCycle} from './storage';
import {AgentSession, agentConfigFromEnv} from './agent';
import {resolveAgentClients} from './agent-ingest';
import {RecordedCycleError, SiteMismatchError, classifyUnifiError, errorDetail} from './errors';

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
let skippedWithoutMac = 0;
const agentAbort = new AbortController();
const stop = () => { stopping = true; agentAbort.abort(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

function classify(error: unknown): string {
  if (error instanceof RecordedCycleError) return error.code;
  if (error instanceof UnifiHttpError) return `http_${error.status}`;
  if (error instanceof UnifiResponseError) return 'unifi_response_invalid';
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

/** The site row rarely changes, so read it first and write only when it is missing or renamed. */
async function ensureSite(client: PoolClient): Promise<string> {
  const existing = await client.query<{id: string}>('SELECT id FROM sites WHERE unifi_id=$1 AND internal_name=$2',
    [siteUuid, internalName]);
  if (existing.rows[0]) return existing.rows[0].id;
  const site = await client.query<{id: string}>(`INSERT INTO sites (unifi_id, internal_name, label) VALUES ($1,$2,$2)
    ON CONFLICT (unifi_id) DO UPDATE SET internal_name=EXCLUDED.internal_name RETURNING id`, [siteUuid, internalName]);
  return site.rows[0].id;
}

/** One collection. Another collector process for the same site holds the lock and makes this a no-op. */
async function cycle(): Promise<void> {
  const startedAt = new Date();
  await withClient(async (client, discard) => {
    const lock = await client.query<{ok: boolean}>('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok', ['unifi-traffic-monitor', siteUuid]);
    if (!lock.rows[0]?.ok) return;
    try {
      await collect(client, startedAt);
    } finally {
      // A lock that cannot be released stays with this session. Closing the
      // connection releases it.
      await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', ['unifi-traffic-monitor', siteUuid])
        .catch(() => discard());
    }
  });
}

async function collect(client: PoolClient, startedAt: Date): Promise<void> {
  const dbSiteId = await ensureSite(client);
  let snapshots: ClientSnapshot[];
  let connected: ConnectedClientSnapshot[];
  let devices: DeviceSnapshot[];
  const fetchStarted = Date.now();
  try {
    const [siteResponse, clientResponse, connectedResponse, deviceResponse] = await Promise.all([
      unifi.getOfficialSites(), unifi.getInternalClients(), unifi.getOfficialConnectedClients(siteUuid), unifi.getOfficialDevices(siteUuid)
    ]);
    const mapped = siteResponse.data.find(row => row.id === siteUuid);
    if (!mapped || mapped.internalReference !== internalName) throw new SiteMismatchError();
    snapshots = extractInternalClients(clientResponse).map(parseClientSnapshot);
    // VPN and Teleport clients have no MAC address. Clients are keyed by MAC, so they are skipped.
    const listed = connectedResponse.data.map(parseConnectedClientSnapshot);
    connected = listed.filter((row): row is ConnectedClientSnapshot => row !== null);
    if (listed.length - connected.length !== skippedWithoutMac) {
      skippedWithoutMac = listed.length - connected.length;
      if (skippedWithoutMac) console.log(`Ignoring ${skippedWithoutMac} connected clients without a MAC address (VPN or Teleport)`);
    }
    devices = deviceResponse.data.map(parseDeviceSnapshot);
    if (new Set(snapshots.map(row => row.mac)).size !== snapshots.length) throw new UnifiResponseError('Duplicate client MAC');
    if (new Set(connected.map(row => row.mac)).size !== connected.length) throw new UnifiResponseError('Duplicate connected client MAC');
    if (new Set(devices.map(row => row.mac)).size !== devices.length) throw new UnifiResponseError('Duplicate device MAC');
  } catch (error) {
    const code = classifyUnifiError(error);
    await recordError(client, dbSiteId, startedAt, code);
    throw new RecordedCycleError(code, error);
  }
  const fetchMs = Date.now() - fetchStarted;
  const saveStarted = Date.now();
  const rawCount = await saveCycle(client, dbSiteId, startedAt, snapshots, connected, devices, counterMappings, maxGapMs);
  console.log(`Collection succeeded: ${snapshots.length} clients, ${connected.length} connected, ${devices.length} devices, ` +
    `${rawCount} raw counters (UniFi ${fetchMs} ms, save ${Date.now() - saveStarted} ms)`);
  if (agentConfig) {
    try {
      const resolved = await resolveAgentClients(client, dbSiteId, await currentAgentLedgerCutoff(client, dbSiteId));
      if (resolved) console.log(`Attached gateway agent usage from ${resolved} buckets to newly listed clients`);
    } catch (error) { console.error(`Gateway agent client matching failed; will retry next cycle: ${errorDetail(error)}`); }
  }
  try {
    const backfilled = await backfillPendingRollups(client, dbSiteId);
    if (backfilled) console.log(`Backfilled ${backfilled} earlier traffic observations`);
  } catch (error) { console.error(`Traffic rollup backfill failed; will retry next cycle: ${errorDetail(error)}`); }
}

/** Retention runs hourly even while UniFi requests fail, because the agent keeps writing. */
async function maintain(): Promise<void> {
  if (Date.now() - lastMaintenanceAt < 3600000) return;
  try {
    const removed = await withClient(async client => pruneExpiredHistory(client, await ensureSite(client)));
    lastMaintenanceAt = Date.now();
    if (removed.intervals || removed.samples || removed.rollups || removed.agentBuckets || removed.runs) {
      console.log(`Pruned ${removed.intervals} intervals, ${removed.samples} samples, ${removed.rollups} rollups, ` +
        `${removed.agentBuckets} agent buckets, ${removed.runs} collection runs`);
    }
  } catch (error) {
    console.error(`History retention failed; will retry next cycle: ${errorDetail(error)}`);
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
      catch (error) { failures++; console.error(`Collector cycle failed: ${classify(error)} (${errorDetail(error)})`); }
      if (!stopping) await maintain();
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
