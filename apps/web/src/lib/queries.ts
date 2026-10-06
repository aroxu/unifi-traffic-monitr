import 'server-only';
import { and, asc, desc, eq, ilike, ne, or, sql } from 'drizzle-orm';
import { clientSamples, clients, collectorRuns, devices, getDb, getOverviewTraffic, getPool, sites, withClient } from '@utm/db';
import type {ClientListQuery} from '@utm/contracts';
import type {Pool, PoolClient} from 'pg';

/** Today's gateway-measured bytes and the time the newest stored bucket update arrived. */
export type AgentToday = {asOf: string | null; internet: {up: number; down: number}; lan: {up: number; down: number}};

async function agentToday(executor: Pool | PoolClient, siteId: string, clientId?: string): Promise<AgentToday> {
  // Separate statements let each use its own index: site and time, or client and time.
  const filter = clientId ? 'b.client_id=$2' : 'b.site_id=$1';
  const result = await executor.query<{scope: string; direction: string; bytes: string; as_of: Date | null}>(`
    SELECT b.scope, b.direction, sum(b.bytes)::text AS bytes, max(b.received_at) AS as_of
    FROM agent_buckets b
    WHERE ${filter} AND b.site_id=$1
      AND b.bucket_start >= (SELECT date_trunc('day', now() AT TIME ZONE s.tz) AT TIME ZONE s.tz
        FROM (SELECT COALESCE((SELECT timezone FROM settings WHERE id=1), 'Asia/Seoul') AS tz) s)
    GROUP BY b.scope, b.direction`, clientId ? [siteId, clientId] : [siteId]);
  const today: AgentToday = {asOf: null, internet: {up: 0, down: 0}, lan: {up: 0, down: 0}};
  for (const row of result.rows) {
    const scope = row.scope === 'internet' ? today.internet : row.scope === 'lan' ? today.lan : null;
    if (!scope) continue;
    if (row.direction === 'upload') scope.up = Number(row.bytes);
    if (row.direction === 'download') scope.down = Number(row.bytes);
    if (row.as_of && (!today.asOf || row.as_of.toISOString() > today.asOf)) today.asOf = row.as_of.toISOString();
  }
  return today;
}

/** Today's gateway-measured usage for one client, or null when the agent was never configured. */
export async function getClientAgentToday(clientId: string): Promise<AgentToday | null> {
  const site = await getPool().query<{site_id: string}>(`SELECT c.site_id FROM clients c
    JOIN agent_status a ON a.site_id=c.site_id WHERE c.id=$1`, [clientId]);
  return site.rows[0] ? agentToday(getPool(), site.rows[0].site_id, clientId) : null;
}

export async function getOverview() {
  return withClient(async client => {
    // One snapshot for the whole page. A connection runs one query at a time,
    // so the queries are awaited in turn.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const db = getDb(client);
      const end = new Date();
      const siteRows = await db.select({id: sites.id, label: sites.label}).from(sites).orderBy(desc(sites.createdAt)).limit(10);
      const [counts] = await db.select({total: sql<number>`count(*)::int`, known: sql<number>`count(${clients.online})::int`,
        online: sql<number>`count(*) filter (where ${clients.online} = true)::int`,
        offline: sql<number>`count(*) filter (where ${clients.online} = false)::int`}).from(clients);
      const [latestRun] = await db.select().from(collectorRuns).orderBy(desc(collectorRuns.startedAt)).limit(1);
      const [lastSuccess] = await db.select({startedAt: collectorRuns.startedAt}).from(collectorRuns)
        .where(ne(collectorRuns.status, 'error')).orderBy(desc(collectorRuns.startedAt)).limit(1);
      const site = siteRows[0];
      const measured = site ? (await client.query<{present: boolean}>(`SELECT EXISTS (SELECT 1 FROM traffic_rollups
        WHERE site_id=$1 AND observed_seconds>0 LIMIT 1) AS present`, [site.id])).rows[0]?.present ?? false : false;
      const traffic = site ? await getOverviewTraffic(new Date(end.getTime() - 86400000), end, site.id, client) : null;
      const agentRow = site ? (await client.query<{connected: boolean | null; agent_version: string | null;
        last_frame_at: Date | null; last_error: string | null}>(
        `SELECT connected AND last_frame_at > now() - interval '60 seconds' AS connected, agent_version, last_frame_at, last_error
          FROM agent_status WHERE site_id=$1`, [site.id])).rows[0] : undefined;
      const labelRows = site ? (await client.query<{id: string; label: string}>(
        'SELECT id, COALESCE(name, mac) AS label FROM clients WHERE site_id=$1', [site.id])).rows : [];
      const todayUsage = site && agentRow ? await agentToday(client, site.id) : null;
      const ran = latestRun && latestRun.status !== 'error';
      const [rawSamples] = ran ? await db.select({count: sql<number>`count(*)::int`,
        clients: sql<number>`count(distinct ${clientSamples.clientId})::int`})
        .from(clientSamples).where(eq(clientSamples.runId, latestRun.id)) : [];
      await client.query('COMMIT');
      return {sites: siteRows, clientCount: counts?.total ?? 0, onlineCount: counts?.known ? counts.online : null,
        offlineCount: counts?.known ? counts.offline : null,
        latestRun: latestRun ?? null, lastSuccessAt: lastSuccess?.startedAt ?? null,
        rawCounterCount: ran ? rawSamples?.count ?? 0 : null,
        counterClientCount: ran ? rawSamples?.clients ?? 0 : null,
        hasMeasuredUsage: measured, traffic,
        agent: agentRow ? {connected: agentRow.connected === true, version: agentRow.agent_version, lastFrameAt: agentRow.last_frame_at,
          lastError: agentRow.last_error, today: todayUsage} : null,
        clientLabels: Object.fromEntries(labelRows.map(row => [row.id, row.label]))};
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

export async function getClients({q, page, limit, connection, deviceId, sort}: ClientListQuery) {
  const db = getDb();
  const escaped = q.replace(/[\\%_]/g, '\\$&');
  const filter = and(
    q ? or(ilike(clients.name, `%${escaped}%`), ilike(clients.ip, `%${escaped}%`), ilike(clients.mac, `%${escaped}%`)) : undefined,
    connection === 'all' ? undefined : eq(clients.connection, connection),
    deviceId ? eq(clients.deviceId, deviceId) : undefined
  );
  const [rows, total] = await Promise.all([
    db.select({id: clients.id, name: clients.name, mac: clients.mac, ip: clients.ip, connection: clients.connection,
      online: clients.online, lastSeenAt: clients.lastSeenAt, deviceId: clients.deviceId, deviceName: devices.name,
      measured: sql<boolean>`exists (select 1 from traffic_rollups r where r.client_id=${clients.id} and r.observed_seconds>0)`})
      .from(clients).leftJoin(devices, eq(clients.deviceId, devices.id)).where(filter)
      .orderBy(sort === 'name' ? asc(clients.name) : desc(clients.updatedAt), asc(clients.id))
      .limit(limit).offset((page - 1) * limit),
    db.select({count: sql<number>`count(*)::int`}).from(clients).where(filter)
  ]);
  return {rows, total: total[0]?.count ?? 0};
}

export async function getClient(id: string) {
  const rows = await getDb().select().from(clients).where(eq(clients.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getClientConnection(deviceId: string | null) {
  if (!deviceId) return null;
  const rows = await getDb().select({id: devices.id, name: devices.name, model: devices.model, online: devices.online})
    .from(devices).where(eq(devices.id, deviceId)).limit(1);
  return rows[0] ?? null;
}

export async function getClientRecentSamples(id: string) {
  return getDb().select({source: clientSamples.source, quality: clientSamples.quality, collectedAt: clientSamples.collectedAt})
    .from(clientSamples).where(eq(clientSamples.clientId, id)).orderBy(desc(clientSamples.collectedAt)).limit(4);
}

export async function getDevices() { return getDb().select().from(devices).orderBy(devices.name); }
export async function getDeviceClientCounts() {
  return getDb().select({deviceId: clients.deviceId, count: sql<number>`count(*)::int`}).from(clients)
    .where(eq(clients.online, true)).groupBy(clients.deviceId);
}
export async function getLatestRuns() { return getDb().select().from(collectorRuns).orderBy(desc(collectorRuns.startedAt)).limit(10); }

export type AgentStatus = {connected: boolean; agentVersion: string | null; connectedAt: Date | null; disconnectedAt: Date | null;
  lastFrameAt: Date | null; lastFinalBucket: Date | null; earliestAvailable: Date | null; lastError: string | null};

/** Gateway agent state for the newest site, or null when no agent was ever configured. */
export async function getAgentStatus(): Promise<AgentStatus | null> {
  const result = await getPool().query<{connected: boolean; agent_version: string | null; connected_at: Date | null;
    disconnected_at: Date | null; last_frame_at: Date | null; last_final_bucket: Date | null; earliest_available: Date | null;
    last_error: string | null}>(`SELECT a.connected AND a.last_frame_at > now() - interval '60 seconds' AS connected,
      a.agent_version, a.connected_at, a.disconnected_at, a.last_frame_at, a.last_final_bucket, a.earliest_available, a.last_error
    FROM agent_status a JOIN sites s ON s.id=a.site_id ORDER BY s.created_at DESC LIMIT 1`);
  const row = result.rows[0];
  return row ? {connected: row.connected, agentVersion: row.agent_version, connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at, lastFrameAt: row.last_frame_at, lastFinalBucket: row.last_final_bucket,
    earliestAvailable: row.earliest_available, lastError: row.last_error} : null;
}

/** Traffic from client addresses whose MAC the gateway did not know, last 24 hours. */
export async function getAgentUnattributed(): Promise<{upload: string; download: string}> {
  const result = await getPool().query<{upload: string | null; download: string | null}>(`SELECT
      sum(bytes) FILTER (WHERE direction='upload')::text AS upload, sum(bytes) FILTER (WHERE direction='download')::text AS download
    FROM agent_buckets WHERE site_id=(SELECT id FROM sites ORDER BY created_at DESC LIMIT 1)
      AND subject='unattributed' AND bucket_start >= now() - interval '24 hours'`);
  return {upload: result.rows[0]?.upload ?? '0', download: result.rows[0]?.download ?? '0'};
}
