// Message parsing for the gateway agent's WebSocket stream (protocol v1).

export type AgentPair = {up: bigint; down: bigint};
export type AgentSubject = {mac: string; internet: AgentPair; lan: AgentPair};
export type AgentBucket = {start: Date; final: boolean; coverageSeconds: number; subjects: AgentSubject[]};
export type LivePair = {up: number; down: number};
export type LiveSubject = {mac: string; internet: LivePair; lan: LivePair};
export type AgentHello = {agentId: string; runId: string; version: string; now: Date; earliestBucket: Date | null};
export type AgentMessage =
  | {type: 'hello'; hello: AgentHello}
  | {type: 'buckets'; items: AgentBucket[]}
  | {type: 'bucket'; bucket: AgentBucket}
  | {type: 'replay_done'; through: Date | null}
  | {type: 'live'; at: Date; intervalMs: number; subjects: LiveSubject[]};

export const UNATTRIBUTED = 'unattributed';
const macPattern = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const decimal = /^(?:0|[1-9][0-9]{0,19})$/;
const maxU64 = (1n << 64n) - 1n;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(what: string): never { throw new Error(`Invalid agent message: ${what}`); }

function time(v: unknown, what: string): Date {
  if (typeof v !== 'string') fail(what);
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) fail(what);
  return d;
}

function optionalTime(v: unknown, what: string): Date | null {
  return v === null || v === undefined ? null : time(v, what);
}

function counter(v: unknown): bigint {
  if (typeof v !== 'string' || !decimal.test(v)) fail('byte count');
  const n = BigInt(v);
  if (n > maxU64) fail('byte count');
  return n;
}

function subjectName(v: unknown): string {
  if (typeof v !== 'string' || (v !== UNATTRIBUTED && !macPattern.test(v))) fail('subject');
  return v;
}

function pair(v: unknown): AgentPair {
  if (!isObject(v)) fail('pair');
  return {up: counter(v.up), down: counter(v.down)};
}

function livePair(v: unknown): LivePair {
  if (!isObject(v)) fail('live pair');
  const {up, down} = v;
  if (!Number.isSafeInteger(up) || !Number.isSafeInteger(down) || (up as number) < 0 || (down as number) < 0) fail('live bytes');
  return {up: up as number, down: down as number};
}

export function parseBucket(v: unknown): AgentBucket {
  if (!isObject(v) || typeof v.final !== 'boolean' || !Array.isArray(v.subjects)) fail('bucket');
  const start = time(v.start, 'bucket start');
  if (start.getTime() % 300000 !== 0) fail('bucket alignment');
  const coverage = v.coverageSeconds;
  if (!Number.isSafeInteger(coverage) || (coverage as number) < 0 || (coverage as number) > 300) fail('coverage');
  const seen = new Set<string>();
  const subjects = v.subjects.map(row => {
    if (!isObject(row)) fail('subject');
    const mac = subjectName(row.mac);
    if (seen.has(mac)) fail('duplicate subject');
    seen.add(mac);
    return {mac, internet: pair(row.internet), lan: pair(row.lan)};
  });
  return {start, final: v.final, coverageSeconds: coverage as number, subjects};
}

export function parseAgentMessage(raw: string): AgentMessage {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { fail('JSON'); }
  if (!isObject(v)) fail('object');
  switch (v.type) {
    case 'hello': {
      if (v.protocol !== 1) fail('unsupported protocol version');
      if (typeof v.agentId !== 'string' || typeof v.version !== 'string') fail('hello');
      // Agents before 0.2.0 send no run ID; they restored their counts from disk.
      if (v.runId !== undefined && (typeof v.runId !== 'string' || v.runId.length > 64)) fail('run ID');
      return {type: 'hello', hello: {agentId: v.agentId.slice(0, 64), runId: (v.runId as string | undefined) ?? '', version: v.version.slice(0, 64),
        now: time(v.now, 'hello time'), earliestBucket: optionalTime(v.earliestBucket, 'earliest bucket')}};
    }
    case 'buckets':
      if (!Array.isArray(v.items)) fail('buckets');
      return {type: 'buckets', items: v.items.map(parseBucket)};
    case 'bucket':
      return {type: 'bucket', bucket: parseBucket(v.bucket)};
    case 'replay_done':
      return {type: 'replay_done', through: optionalTime(v.through, 'replay end')};
    case 'live': {
      if (!Array.isArray(v.subjects) || !Number.isSafeInteger(v.intervalMs) || (v.intervalMs as number) <= 0) fail('live');
      return {type: 'live', at: time(v.at, 'live time'), intervalMs: v.intervalMs as number,
        subjects: v.subjects.map(row => {
          if (!isObject(row)) fail('live subject');
          return {mac: subjectName(row.mac), internet: livePair(row.internet), lan: livePair(row.lan)};
        })};
    }
    default:
      fail('type');
  }
}

export type LivePayload = {
  state: 'live'; at: string; intervalMs: number;
  totals: {internet: LivePair; lan: LivePair};
  // [clientId, internet up, internet down, LAN up, LAN down], bytes per second.
  clients: [string, number, number, number, number][];
  omitted: number;
};

/** PostgreSQL rejects NOTIFY payloads of 8000 bytes or more. */
export const maxLivePayloadBytes = 7000;

/** Convert a live frame to per-second rates and keep the payload under the NOTIFY limit. */
export function buildLivePayload(msg: Extract<AgentMessage, {type: 'live'}>, clientIds: Map<string, string>): string {
  const rate = (bytes: number) => Math.round(bytes * 1000 / msg.intervalMs);
  const totals = {internet: {up: 0, down: 0}, lan: {up: 0, down: 0}};
  const rows: [string, number, number, number, number][] = [];
  for (const s of msg.subjects) {
    const r = [rate(s.internet.up), rate(s.internet.down), rate(s.lan.up), rate(s.lan.down)] as const;
    totals.internet.up += r[0]; totals.internet.down += r[1]; totals.lan.up += r[2]; totals.lan.down += r[3];
    const id = clientIds.get(s.mac);
    if (id && r.some(value => value > 0)) rows.push([id, ...r]);
  }
  rows.sort((a, b) => (b[1] + b[2]) - (a[1] + a[2]) || (b[3] + b[4]) - (a[3] + a[4]));
  const payload: LivePayload = {state: 'live', at: msg.at.toISOString(), intervalMs: msg.intervalMs, totals, clients: rows, omitted: 0};
  let text = JSON.stringify(payload);
  while (Buffer.byteLength(text) > maxLivePayloadBytes && payload.clients.length) {
    const drop = Math.max(1, Math.ceil(payload.clients.length / 10));
    payload.clients = payload.clients.slice(0, payload.clients.length - drop);
    payload.omitted += drop;
    text = JSON.stringify(payload);
  }
  return text;
}
