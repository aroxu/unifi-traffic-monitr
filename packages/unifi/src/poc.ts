import { createHash, randomBytes } from 'node:crypto';
import { UnifiClient, extractData, extractInternalClients, unifiConfigFromEnv } from './index';

const fields = [
  'rx_bytes', 'tx_bytes', 'rx_bytes-r', 'tx_bytes-r',
  'wired-rx_bytes', 'wired-tx_bytes', 'wired-rx_bytes-r', 'wired-tx_bytes-r',
  'ap_mac', 'sw_mac', 'sw_port', 'is_wired', 'last_seen', 'first_seen', 'uptime'
];

async function main() {
  const client = new UnifiClient(unifiConfigFromEnv());
  const salt = randomBytes(16);
  let official: {status: string; sites?: {id: string; internalReference: string | null; name: string | null}[]} = {status: 'not_checked'};
  try {
    const payload = await client.getOfficialSites();
    const rows = extractData(payload);
    official = {status: 'ok', sites: rows.map(row => ({
      id: typeof row.id === 'string' ? row.id : 'unknown',
      internalReference: typeof row.internalReference === 'string' ? row.internalReference : null,
      name: typeof row.name === 'string' ? row.name : null
    }))};
  } catch (error) {
    official = {status: error instanceof Error ? error.message : 'unknown_error'};
  }
  const payload = await client.getInternalClients();
  const rows = extractInternalClients(payload);
  const wrapper = payload as Record<string, unknown>;
  const coverage = Object.fromEntries(fields.map(field => [field, rows.filter(row => Object.hasOwn(row, field)).length]));
  const examples = rows.slice(0, 5).map((row, index) => ({
    id: createHash('sha256').update(salt).update(String(row.mac ?? index)).digest('hex').slice(0, 12),
    fields: Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field,
      field.endsWith('_bytes') || field.endsWith('_bytes-r') ? String(row[field]) : typeof row[field]
    ]))
  }));
  console.log(JSON.stringify({checkedAt: new Date().toISOString(), official, internal: {
    rowCount: rows.length, meta: wrapper.meta && typeof wrapper.meta === 'object' ? {
      rc: (wrapper.meta as Record<string, unknown>).rc,
      count: (wrapper.meta as Record<string, unknown>).count
    } : null, coverage, examples
  }, note: 'Anonymous IDs change each run. Direction and internet/LAN scope are unverified.'}, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'PoC failed'); process.exitCode = 1; });
