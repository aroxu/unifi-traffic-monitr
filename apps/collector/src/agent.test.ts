import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import WebSocket, {WebSocketServer, type ClientOptions} from 'ws';
import {AgentPinError, agentConfigFromEnv, fetchPinnedCertificate, normalizeFingerprint} from './agent';
import {buildLivePayload, maxLivePayloadBytes, parseAgentMessage} from './agent-protocol';

const token = 'x'.repeat(40);
const pin = 'AB:'.repeat(31) + 'AB';

describe('agent configuration', () => {
  it('requires all three variables together', () => {
    expect(agentConfigFromEnv({})).toBeNull();
    expect(() => agentConfigFromEnv({UNIFI_AGENT_URL: 'wss://10.0.0.1:8790/v1/stream'})).toThrow(/together/);
    expect(() => agentConfigFromEnv({UNIFI_AGENT_URL: 'ws://10.0.0.1:8790/v1/stream', UNIFI_AGENT_TOKEN: token,
      UNIFI_AGENT_CERT_SHA256: pin})).toThrow(/wss/);
    const cfg = agentConfigFromEnv({UNIFI_AGENT_URL: 'wss://10.0.0.1:8790/v1/stream', UNIFI_AGENT_TOKEN: token,
      UNIFI_AGENT_CERT_SHA256: pin.toLowerCase()});
    expect(cfg?.fingerprint).toBe('AB'.repeat(32));
    expect(() => normalizeFingerprint('abc')).toThrow();
  });
});

describe('agent messages', () => {
  it('keeps 64-bit byte counts exact and rejects malformed buckets', () => {
    const bucket = {start: '2026-09-30T03:05:00Z', final: true, coverageSeconds: 300, subjects: [
      {mac: 'aa:bb:cc:dd:ee:ff', internet: {up: '18446744073709551615', down: '1'}, lan: {up: '0', down: '0'}}]};
    const parsed = parseAgentMessage(JSON.stringify({type: 'bucket', bucket}));
    expect(parsed.type === 'bucket' && parsed.bucket.subjects[0].internet.up).toBe(18446744073709551615n);
    expect(() => parseAgentMessage(JSON.stringify({type: 'bucket', bucket: {...bucket, start: '2026-09-30T03:06:00Z'}}))).toThrow(/alignment/);
    expect(() => parseAgentMessage(JSON.stringify({type: 'bucket', bucket: {...bucket, subjects: [
      {...bucket.subjects[0], internet: {up: '-1', down: '0'}}]}}))).toThrow(/byte count/);
    expect(() => parseAgentMessage(JSON.stringify({type: 'hello', protocol: 2, agentId: 'a', version: 'v', now: bucket.start}))).toThrow(/protocol/);
  });

  it('converts live frames to rates and stays under the NOTIFY limit', () => {
    const subjects = Array.from({length: 300}, (_, i) => ({
      mac: `02:00:00:00:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`,
      internet: {up: 1000 + i, down: 2000000 + i}, lan: {up: 0, down: 10}}));
    const ids = new Map(subjects.map((s, i) => [s.mac, `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`]));
    const text = buildLivePayload({type: 'live', at: new Date('2026-09-30T03:00:00Z'), intervalMs: 2000, subjects}, ids);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxLivePayloadBytes);
    const payload = JSON.parse(text);
    expect(payload.omitted).toBeGreaterThan(0);
    expect(payload.clients.length + payload.omitted).toBe(300);
    expect(payload.clients[0][2]).toBe(1000150); // highest download first, bytes per second
    expect(payload.totals.internet.up).toBe(subjects.reduce((sum, s) => sum + Math.round(s.internet.up / 2), 0));
  });
});

let openssl = true;
try { execFileSync('openssl', ['version'], {stdio: 'ignore'}); } catch { openssl = false; }

describe.skipIf(!openssl)('certificate pinning', () => {
  let dir = '';
  let port = 0;
  let fingerprint = '';
  let headers: (string | undefined)[] = [];
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'utm-agent-pin-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
      '-subj', '/CN=unifi-traffic-agent', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], {stdio: 'ignore'});
    const cert = readFileSync(join(dir, 'cert.pem'));
    fingerprint = normalizeFingerprint(new X509Certificate(cert).fingerprint256);
    server = createServer({cert, key: readFileSync(join(dir, 'key.pem'))});
    const wss = new WebSocketServer({noServer: true});
    server.on('upgrade', (request, socket, head) => {
      headers.push(request.headers.authorization);
      wss.handleUpgrade(request, socket, head, ws => ws.send('ok'));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server?.close(); rmSync(dir, {recursive: true, force: true}); });

  it('sends the token only after the pinned certificate matches', async () => {
    const url = new URL(`wss://127.0.0.1:${port}/v1/stream`);
    await expect(fetchPinnedCertificate(url, 'AB'.repeat(32))).rejects.toBeInstanceOf(AgentPinError);
    expect(headers).toEqual([]);
    const pem = await fetchPinnedCertificate(url, fingerprint);
    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url, {ca: pem, headers: {Authorization: `Bearer ${token}`},
        checkServerIdentity: (() => undefined) as unknown as ClientOptions['checkServerIdentity']});
      ws.on('message', data => { resolve(data.toString()); ws.close(); });
      ws.on('error', reject);
    });
    expect(message).toBe('ok');
    expect(headers).toEqual([`Bearer ${token}`]);
  });
});
