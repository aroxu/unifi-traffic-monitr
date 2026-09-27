import {UnifiClient, unifiConfigFromEnv} from './index';

function date(name: string): Date {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid ${name}`);
  return parsed;
}

async function main(): Promise<void> {
  const start = date('DPI_START');
  const end = date('DPI_END');
  const mac = process.env.DPI_CLIENT_MAC || undefined;
  // The probe never prints the client identity, URL, credentials, or raw response.
  const client = new UnifiClient(unifiConfigFromEnv());
  try {
    const rows = await client.getDpiTraffic(start, end, mac);
    const receivedBytes = rows.reduce((sum, row) => sum + row.apps.reduce((n, app) => n + app.receivedBytes, 0n), 0n);
    const transmittedBytes = rows.reduce((sum, row) => sum + row.apps.reduce((n, app) => n + app.transmittedBytes, 0n), 0n);
    console.log(JSON.stringify({start: start.toISOString(), end: end.toISOString(),
      clients: rows.length, apps: rows.reduce((sum, row) => sum + row.apps.length, 0),
      receivedBytes: receivedBytes.toString(), transmittedBytes: transmittedBytes.toString(),
      scope: 'gateway_dpi_unverified', note: 'Read-only snapshot; recent periods can change and boundaries need validation. Do not use as traffic rollups.'}));
  } finally {await client.close();}
}

main().catch(error => {
  console.error(error instanceof Error ? error.name : 'DpiProbeError');
  process.exitCode = 1;
});
