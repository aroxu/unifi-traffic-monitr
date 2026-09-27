export type RawCounter = {source: string; direction: 'rx' | 'tx'; value: bigint; sessionKey: string | null};
export type ClientSnapshot = {
  mac: string;
  unifiId: string | null;
  name: string | null;
  ip: string | null;
  connection: 'wired' | 'wireless';
  deviceMac: string | null;
  lastSeenAt: Date | null;
  wirelessQuality: {signalDbm: number | null; noiseDbm: number | null} | null;
  counters: RawCounter[];
};

const macPattern = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const shortString = (value: unknown) => typeof value === 'string' && value.length <= 255 ? value : null;
const macString = (value: unknown) => typeof value === 'string' && macPattern.test(value) ? value.toLowerCase() : null;
const epochSeconds = (value: unknown): Date | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
};
const dbm = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= -127 && value <= 0 ? value : null;

function counter(value: unknown, field: string): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= 9223372036854775807n) return parsed;
  }
  throw new Error(`Invalid ${field} counter`);
}

/** Preserve source labels until a controlled transfer establishes traffic direction and scope. */
export function parseClientSnapshot(row: Record<string, unknown>): ClientSnapshot {
  const mac = macString(row.mac);
  if (!mac) throw new Error('Invalid client MAC');
  if (typeof row.is_wired !== 'boolean') throw new Error('Missing client connection type');
  const connection = row.is_wired ? 'wired' : 'wireless';
  const prefix = row.is_wired ? 'wired-' : '';
  const rxField = `${prefix}rx_bytes`;
  const txField = `${prefix}tx_bytes`;
  const hasRx = Object.hasOwn(row, rxField);
  const hasTx = Object.hasOwn(row, txField);
  if (hasRx !== hasTx) throw new Error('Partial client counters');
  const session = epochSeconds(row.latest_assoc_time) ?? epochSeconds(row.assoc_time);
  return {
    mac, unifiId: shortString(row._id), name: shortString(row.name) ?? shortString(row.hostname),
    ip: shortString(row.ip), connection,
    deviceMac: macString(row.is_wired ? row.sw_mac : row.ap_mac),
    lastSeenAt: epochSeconds(row.last_seen),
    wirelessQuality: row.is_wired ? null : {signalDbm: dbm(row.signal), noiseDbm: dbm(row.noise)},
    counters: hasRx ? [
      {source: `sta:${rxField}`, direction: 'rx', value: counter(row[rxField], rxField), sessionKey: session?.toISOString() ?? null},
      {source: `sta:${txField}`, direction: 'tx', value: counter(row[txField], txField), sessionKey: session?.toISOString() ?? null}
    ] : []
  };
}

export type DeviceSnapshot = {unifiId: string; mac: string; name: string | null; model: string | null; online: boolean | null};
export function parseDeviceSnapshot(row: Record<string, unknown>): DeviceSnapshot {
  const unifiId = shortString(row.id);
  const mac = macString(row.macAddress);
  if (!unifiId || !mac) throw new Error('Invalid UniFi device identity');
  return {unifiId, mac, name: shortString(row.name), model: shortString(row.model),
    online: row.state === 'ONLINE' ? true : row.state === 'OFFLINE' ? false : null};
}

export type ConnectedClientSnapshot = {
  mac: string; unifiId: string | null; name: string | null; ip: string | null;
  connection: 'wired' | 'wireless' | null; uplinkDeviceUnifiId: string | null;
};
export function parseConnectedClientSnapshot(row: Record<string, unknown>): ConnectedClientSnapshot {
  const mac = macString(row.macAddress);
  if (!mac) throw new Error('Invalid connected client MAC');
  return {mac, unifiId: shortString(row.id), name: shortString(row.name), ip: shortString(row.ipAddress),
    connection: row.type === 'WIRED' ? 'wired' : row.type === 'WIRELESS' ? 'wireless' : null,
    uplinkDeviceUnifiId: shortString(row.uplinkDeviceId)};
}
