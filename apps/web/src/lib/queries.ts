import 'server-only';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { clientSamples, clients, collectorRuns, devices, getDb, getOverviewTraffic, getPool, sites } from '@utm/db';
import type {ClientListQuery} from '@utm/contracts';

export async function getOverview() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const db = getDb(client);
    const end = new Date();
    const [siteRows, clientCount, onlineStatus, latestRun] = await Promise.all([
      db.select({id: sites.id, label: sites.label}).from(sites).orderBy(desc(sites.createdAt)).limit(10),
      db.select({count: sql<number>`count(*)::int`}).from(clients),
      db.select({known: sql<number>`count(${clients.online})::int`, online: sql<number>`count(*) filter (where ${clients.online} = true)::int`, offline: sql<number>`count(*) filter (where ${clients.online} = false)::int`}).from(clients),
      db.select().from(collectorRuns).orderBy(desc(collectorRuns.startedAt)).limit(1)
    ]);
    const [measured, traffic] = siteRows[0] ? await Promise.all([
      client.query<{present: boolean}>(`SELECT EXISTS (SELECT 1 FROM traffic_rollups
        WHERE site_id=$1 AND observed_seconds>0 LIMIT 1) AS present`, [siteRows[0].id]),
      getOverviewTraffic(new Date(end.getTime() - 86400000), end, siteRows[0].id, client)
    ]) : [null, null];
    const rawSamples = latestRun[0] && latestRun[0].status !== 'error'
      ? await db.select({count: sql<number>`count(*)::int`,
        clients: sql<number>`count(distinct ${clientSamples.clientId})::int`})
        .from(clientSamples).where(eq(clientSamples.runId, latestRun[0].id)) : [];
    await client.query('COMMIT');
    return {sites: siteRows, clientCount: clientCount[0]?.count ?? 0, onlineCount: onlineStatus[0]?.known ? onlineStatus[0].online : null,
      offlineCount: onlineStatus[0]?.known ? onlineStatus[0].offline : null,
      latestRun: latestRun[0] ?? null, rawCounterCount: latestRun[0] && latestRun[0].status !== 'error' ? rawSamples[0]?.count ?? 0 : null,
      counterClientCount: latestRun[0] && latestRun[0].status !== 'error' ? rawSamples[0]?.clients ?? 0 : null,
      hasMeasuredUsage: measured?.rows[0]?.present ?? false, traffic};
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
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
