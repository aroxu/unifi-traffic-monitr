export type DpiAppUsage = {
  application: number;
  category: number;
  receivedBytes: bigint;
  transmittedBytes: bigint;
};

export type DpiClientUsage = {mac: string; apps: DpiAppUsage[]};

const macPattern = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const maxBigint = 9223372036854775807n;

function bytes(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= maxBigint) return parsed;
  }
  throw new Error('Invalid DPI byte counter');
}

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid DPI app identity');
  return value;
}

function appUsage(value: unknown): DpiAppUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid DPI app usage');
  const entry = value as Record<string, unknown>;
  const receivedBytes = bytes(entry.bytes_received);
  const transmittedBytes = bytes(entry.bytes_transmitted);
  const total = bytes(entry.total_bytes);
  if (receivedBytes + transmittedBytes !== total) throw new Error('Inconsistent DPI app bytes');
  return {application: id(entry.application), category: id(entry.category), receivedBytes, transmittedBytes};
}

const appKey = (app: DpiAppUsage) => `${app.application}:${app.category}`;

/** Internal, version-dependent gateway DPI response. Parse the entire page before using any values. */
export function parseDpiTraffic(payload: unknown): DpiClientUsage[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid DPI response');
  const wrapper = payload as Record<string, unknown>;
  const rows = wrapper.client_usage_by_app;
  if (!Array.isArray(rows)) throw new Error('Missing DPI clients');
  const seen = new Set<string>();
  const clients = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid DPI client');
    const wrapped = row as Record<string, unknown>;
    const client = wrapped.client;
    if (!client || typeof client !== 'object' || Array.isArray(client)) throw new Error('Invalid DPI client identity');
    const mac = (client as Record<string, unknown>).mac;
    if (typeof mac !== 'string' || !macPattern.test(mac)) throw new Error('Invalid DPI client MAC');
    const normalized = mac.toLowerCase();
    if (seen.has(normalized)) throw new Error('Duplicate DPI client');
    seen.add(normalized);
    if (!Array.isArray(wrapped.usage_by_app)) throw new Error('Missing DPI app usage');
    const apps = wrapped.usage_by_app.map(appUsage);
    return {mac: normalized, apps};
  });
  if (Object.hasOwn(wrapper, 'total_usage_by_app')) {
    if (!Array.isArray(wrapper.total_usage_by_app)) throw new Error('Invalid DPI site totals');
    const reported = new Map<string, DpiAppUsage>();
    for (const item of wrapper.total_usage_by_app) {
      const app = appUsage(item);
      const key = appKey(app);
      if (reported.has(key)) throw new Error('Duplicate DPI site app');
      reported.set(key, app);
    }
    const computed = new Map<string, {receivedBytes: bigint; transmittedBytes: bigint}>();
    for (const client of clients) for (const app of client.apps) {
      const key = appKey(app);
      const total = computed.get(key) ?? {receivedBytes: 0n, transmittedBytes: 0n};
      total.receivedBytes += app.receivedBytes;
      total.transmittedBytes += app.transmittedBytes;
      computed.set(key, total);
    }
    if (computed.size !== reported.size || [...computed].some(([key, sum]) =>
      sum.receivedBytes !== reported.get(key)?.receivedBytes || sum.transmittedBytes !== reported.get(key)?.transmittedBytes)) {
      throw new Error('DPI site totals do not match clients');
    }
  }
  return clients;
}
