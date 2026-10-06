import {execFileSync} from 'node:child_process';
import {X509Certificate, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {afterAll, describe, expect, it} from 'vitest';
import {WebSocketServer} from 'ws';
import {getPool, withClient} from '@utm/db';
import {AgentSession, normalizeFingerprint} from './agent';

let openssl = true;
try { execFileSync('openssl', ['version'], {stdio: 'ignore'}); } catch { openssl = false; }

const until = async <T>(read: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

describe.skipIf(process.env.DB_INTEGRATION !== '1')('database connection failures', () => {
  afterAll(async () => { await getPool().end(); });

  it('keeps running when a checked-out connection drops, and does not reuse it', async () => {
    const pool = new Pool({connectionString: process.env.DATABASE_URL, max: 2});
    pool.on('error', () => {});
    try {
      const dropped = await withClient(async client => {
        const pid = (await client.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        // Ended from another session while no query runs on this one. Without
        // a listener the resulting 'error' event would end the process.
        await getPool().query('SELECT pg_terminate_backend($1)', [pid]);
        await new Promise(resolve => setTimeout(resolve, 300));
        return pid;
      }, pool);
      const next = await withClient(async client => (await client.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid, pool);
      expect(next).not.toBe(dropped);
    } finally {
      await pool.end();
    }
  });

  it.skipIf(!openssl)('stores nothing after a failed agent message on the same connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'utm-agent-fail-'));
    const server = createServer();
    const abort = new AbortController();
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
        '-subj', '/CN=unifi-traffic-agent', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], {stdio: 'ignore'});
      const cert = readFileSync(join(dir, 'cert.pem'));
      server.setSecureContext({cert, key: readFileSync(join(dir, 'key.pem'))});
      const site = (await getPool().query<{id: string}>(`INSERT INTO sites (unifi_id,internal_name,label)
        VALUES ($1,'default','test') RETURNING id`, [`agent-session-${randomUUID()}`])).rows[0].id;
      const start = new Date(Math.floor(Date.now() / 300000) * 300000 - 3600000);
      const bucket = (offset: number, up: string) => ({start: new Date(start.getTime() + offset * 300000).toISOString(),
        final: true, coverageSeconds: 300, subjects: [{mac: '02:00:00:00:0a:01', internet: {up, down: '1'}, lan: {up: '0', down: '0'}}]});
      const wss = new WebSocketServer({server});
      wss.on('connection', ws => {
        ws.send(JSON.stringify({type: 'hello', protocol: 1, agentId: 'test', runId: 'run-1', version: 'test',
          now: new Date().toISOString(), earliestBucket: null}));
        ws.once('message', () => {
          // The first batch fits an unsigned 64-bit counter but not a PostgreSQL
          // bigint, so storing it fails. The second batch is valid.
          ws.send(JSON.stringify({type: 'buckets', items: [bucket(0, '9223372036854775808')]}));
          ws.send(JSON.stringify({type: 'buckets', items: [bucket(1, '100')]}));
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const session = new AgentSession({url: new URL(`wss://127.0.0.1:${port}/v1/stream`), token: 'x'.repeat(40),
        fingerprint: normalizeFingerprint(new X509Certificate(cert).fingerprint256)}, getPool(), async () => site);
      const running = session.run(abort.signal);
      const status = await until(async () => (await getPool().query<{last_error: string | null; last_final_bucket: Date | null}>(
        'SELECT last_error, last_final_bucket FROM agent_status WHERE site_id=$1 AND NOT connected AND last_error IS NOT NULL',
        [site])).rows[0]);
      abort.abort();
      await running;
      expect(status.last_error).toMatch(/^storage:/);
      // A stored second batch would move the resume point past the failed one.
      expect(status.last_final_bucket).toBeNull();
      const stored = await getPool().query<{count: string}>('SELECT count(*)::text AS count FROM agent_buckets WHERE site_id=$1', [site]);
      expect(stored.rows[0].count).toBe('0');
    } finally {
      abort.abort();
      server.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
