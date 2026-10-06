import {isIP} from 'node:net';
import tls from 'node:tls';
import type {Pool, PoolClient} from 'pg';
import WebSocket, {type ClientOptions} from 'ws';
import {withClient} from '@utm/db';
import {agentResumePoint, ingestAgentBuckets} from './agent-ingest';
import {buildLivePayload, parseAgentMessage, type AgentMessage} from './agent-protocol';

export type AgentConfig = {url: URL; token: string; fingerprint: string};

export function normalizeFingerprint(value: string): string {
  const hex = value.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) throw new Error('UNIFI_AGENT_CERT_SHA256 must be a SHA-256 certificate fingerprint');
  return hex;
}

/** The three agent variables must be set together; all empty disables the agent. */
export function agentConfigFromEnv(env: NodeJS.ProcessEnv): AgentConfig | null {
  const url = env.UNIFI_AGENT_URL?.trim() ?? '';
  const token = env.UNIFI_AGENT_TOKEN?.trim() ?? '';
  const pin = env.UNIFI_AGENT_CERT_SHA256?.trim() ?? '';
  if (!url && !token && !pin) return null;
  if (!url || !token || !pin) throw new Error('UNIFI_AGENT_URL, UNIFI_AGENT_TOKEN and UNIFI_AGENT_CERT_SHA256 must be set together');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('UNIFI_AGENT_URL is not a valid URL'); }
  if (parsed.protocol !== 'wss:') throw new Error('UNIFI_AGENT_URL must use wss://');
  if (token.length < 32) throw new Error('UNIFI_AGENT_TOKEN is too short');
  return {url: parsed, token, fingerprint: normalizeFingerprint(pin)};
}

export class AgentPinError extends Error {}

function describe(error: unknown): string {
  if (error instanceof AgentPinError) return 'certificate fingerprint mismatch';
  if (error instanceof Error) return ((error as NodeJS.ErrnoException).code ?? error.message).slice(0, 200);
  return 'unknown error';
}

/**
 * Read the agent's certificate without sending credentials and compare it
 * with the pinned fingerprint. The returned PEM becomes the only trusted CA
 * for the WebSocket connection, so the token is sent only to that key holder.
 */
export function fetchPinnedCertificate(url: URL, fingerprint: string, timeoutMs = 10000): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 443);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host, port, rejectUnauthorized: false, servername: isIP(host) ? undefined : host});
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TLS probe timed out')); }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerX509Certificate();
      socket.end();
      if (!cert) { reject(new Error('agent sent no certificate')); return; }
      if (normalizeFingerprint(cert.fingerprint256) !== fingerprint) { reject(new AgentPinError('pin mismatch')); return; }
      resolve(cert.toString());
    });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, {once: true});
  });
}

// ws forwards this to tls.connect, which expects Error | undefined. The
// published typings describe a boolean, so cast the correct runtime shape.
const skipHostnameCheck = (() => undefined) as unknown as ClientOptions['checkServerIdentity'];

/** Keeps one connection to the gateway agent and stores what it sends. */
export class AgentSession {
  private clientIds = new Map<string, string>();
  private clientIdsLoadedAt = 0;
  private relaying = false;
  private lastFrameWrite = 0;

  constructor(private readonly config: AgentConfig, private readonly pool: Pool,
    private readonly ensureSite: (client: PoolClient) => Promise<string>) {}

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const started = Date.now();
      const reason = await this.connectOnce(signal).catch((error: unknown) => describe(error));
      if (signal.aborted) break;
      failures = Date.now() - started > 60000 ? 1 : failures + 1;
      console.error(`Gateway agent connection ended: ${reason}`);
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)) + Math.floor(Math.random() * 1000), signal);
    }
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withClient(client => fn(client), this.pool);
  }

  private async connectOnce(signal: AbortSignal): Promise<string> {
    const siteId = await this.withClient(client => this.ensureSite(client));
    let pem: string;
    try {
      pem = await fetchPinnedCertificate(this.config.url, this.config.fingerprint);
    } catch (error) {
      const reason = describe(error);
      await this.markDisconnected(siteId, reason);
      return reason;
    }
    return new Promise<string>(resolve => {
      const ws = new WebSocket(this.config.url, {
        headers: {Authorization: `Bearer ${this.config.token}`}, ca: pem,
        // The pinned certificate is the only trust anchor; its name is not checked.
        checkServerIdentity: skipHostnameCheck,
        handshakeTimeout: 10000, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024
      });
      let chain: Promise<void> = Promise.resolve();
      let reason = '';
      // After a failed message nothing more is stored from this connection.
      // Storing later buckets would move the resume point past the failed
      // ones, and they would never be requested again.
      let failed = false;
      // Set by hello; every bucket on this connection belongs to that agent run.
      const run = {id: ''};
      let idle: NodeJS.Timeout | undefined;
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { reason ||= 'no data for 45 seconds'; ws.terminate(); }, 45000);
      };
      const onAbort = () => { reason ||= 'collector stopping'; ws.close(1001, 'collector stopping'); };
      signal.addEventListener('abort', onAbort, {once: true});
      ws.on('open', resetIdle);
      ws.on('unexpected-response', (request, response) => {
        reason ||= `HTTP ${response.statusCode}`;
        request.destroy();
        ws.terminate();
      });
      ws.on('message', (data, isBinary) => {
        resetIdle();
        let msg: AgentMessage;
        try {
          if (isBinary) throw new Error('binary message');
          msg = parseAgentMessage(data.toString());
        } catch (error) {
          failed = true;
          reason ||= describe(error);
          ws.terminate();
          return;
        }
        if (msg.type === 'live') { if (!failed) void this.relay(siteId, msg); return; }
        chain = chain.then(() => failed ? undefined : this.handle(ws, siteId, run, msg)).catch((error: unknown) => {
          failed = true;
          reason ||= `storage: ${describe(error)}`;
          ws.terminate();
        });
      });
      ws.on('error', error => { reason ||= describe(error); });
      ws.on('close', (code, text) => {
        clearTimeout(idle);
        signal.removeEventListener('abort', onAbort);
        reason ||= `closed (${code}${text.length ? ` ${text.toString().slice(0, 100)}` : ''})`;
        void chain.then(() => this.markDisconnected(siteId, reason)).catch(() => {}).finally(() => resolve(reason));
      });
    });
  }

  private async handle(ws: WebSocket, siteId: string, run: {id: string}, msg: Exclude<AgentMessage, {type: 'live'}>): Promise<void> {
    switch (msg.type) {
      case 'hello': {
        run.id = msg.hello.runId;
        const since = await this.withClient(async client => {
          await client.query(`INSERT INTO agent_status
              (site_id,connected,agent_id,agent_version,connected_at,earliest_available,last_error,updated_at)
            VALUES ($1,true,$2,$3,now(),$4,NULL,now())
            ON CONFLICT (site_id) DO UPDATE SET connected=true, agent_id=EXCLUDED.agent_id,
              agent_version=EXCLUDED.agent_version, connected_at=now(), earliest_available=EXCLUDED.earliest_available,
              last_error=NULL, updated_at=now()`, [siteId, msg.hello.agentId, msg.hello.version, msg.hello.earliestBucket]);
          return agentResumePoint(client, siteId);
        });
        await this.loadClientIds(siteId);
        ws.send(JSON.stringify({type: 'resume', since: since?.toISOString() ?? null}));
        console.log(`Gateway agent ${msg.hello.version} connected; resuming after ${since?.toISOString() ?? 'the oldest stored bucket'}`);
        return;
      }
      case 'buckets': {
        const result = await this.withClient(client => ingestAgentBuckets(client, siteId, msg.items, run.id));
        if (result.lastFinal) console.log(`Stored ${msg.items.length} gateway agent buckets through ${result.lastFinal.toISOString()}`);
        return;
      }
      case 'bucket': {
        await this.withClient(async client => {
          await ingestAgentBuckets(client, siteId, [msg.bucket], run.id);
          if (msg.bucket.final) await client.query(`SELECT pg_notify('utm_collection', 'agent')`);
        });
        return;
      }
      case 'replay_done':
        await this.withClient(client => client.query(`SELECT pg_notify('utm_collection', 'agent')`));
        console.log(`Gateway agent replay complete${msg.through ? ` through ${msg.through.toISOString()}` : ''}`);
        return;
    }
  }

  private async loadClientIds(siteId: string): Promise<void> {
    const result = await this.pool.query<{mac: string; id: string}>('SELECT mac, id FROM clients WHERE site_id=$1', [siteId]);
    this.clientIds = new Map(result.rows.map(row => [row.mac, row.id]));
    this.clientIdsLoadedAt = Date.now();
  }

  private async relay(siteId: string, msg: Extract<AgentMessage, {type: 'live'}>): Promise<void> {
    // Drop a frame rather than queue behind a slow database.
    if (this.relaying) return;
    this.relaying = true;
    try {
      const stale = Date.now() - this.clientIdsLoadedAt > 60000;
      const unknown = msg.subjects.some(s => s.mac !== 'unattributed' && !this.clientIds.has(s.mac));
      if (stale || (unknown && Date.now() - this.clientIdsLoadedAt > 30000)) await this.loadClientIds(siteId);
      await this.pool.query('SELECT pg_notify($1, $2)', ['utm_live', buildLivePayload(msg, this.clientIds)]);
      if (Date.now() - this.lastFrameWrite > 10000) {
        this.lastFrameWrite = Date.now();
        await this.pool.query('UPDATE agent_status SET last_frame_at=$2, updated_at=now() WHERE site_id=$1', [siteId, msg.at]);
      }
    } catch {
      // The next frame retries.
    } finally {
      this.relaying = false;
    }
  }

  private async markDisconnected(siteId: string, reason: string): Promise<void> {
    await this.pool.query(`INSERT INTO agent_status (site_id,connected,disconnected_at,last_error,updated_at)
      VALUES ($1,false,now(),$2,now())
      ON CONFLICT (site_id) DO UPDATE SET connected=false, disconnected_at=now(), last_error=EXCLUDED.last_error,
        updated_at=now()`, [siteId, reason]).catch(() => {});
    await this.pool.query('SELECT pg_notify($1, $2)', ['utm_live',
      JSON.stringify({state: 'disconnected', at: new Date().toISOString()})]).catch(() => {});
  }
}
