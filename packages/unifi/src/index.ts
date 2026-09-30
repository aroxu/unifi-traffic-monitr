import { readFileSync } from 'node:fs';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
export {parseClientSnapshot, parseConnectedClientSnapshot, parseDeviceSnapshot} from './snapshot';
export type {ClientSnapshot, ConnectedClientSnapshot, DeviceSnapshot, RawCounter} from './snapshot';
export {parseDpiTraffic} from './dpi';
export type {DpiClientUsage, DpiAppUsage} from './dpi';
import {parseDpiTraffic, type DpiClientUsage} from './dpi';

export interface UnifiConfig { url: string; site: string; apiKey?: string; cookie?: string; timeoutMs?: number; connectIp?: string; caFile?: string }
export class UnifiHttpError extends Error {
  constructor(readonly status: number) { super(`UniFi HTTP ${status}`); }
}

export class UnifiClient {
  private readonly dispatcher: Agent | undefined;
  constructor(private readonly config: UnifiConfig, private readonly fetcher: typeof undiciFetch = undiciFetch) {
    const parsed = new URL(config.url);
    if (parsed.protocol !== 'https:') throw new Error('UniFi URL must use HTTPS');
    if (!config.apiKey && !config.cookie) throw new Error('UNIFI_API_KEY or UNIFI_COOKIE is required');
    if (!/^[a-zA-Z0-9_-]+$/.test(config.site)) throw new Error('Invalid internal site name');
    if (config.connectIp && !isIP(config.connectIp)) throw new Error('UNIFI_CONNECT_IP must be an IP address');
    if (config.connectIp || config.caFile) {
      let ca: string | undefined;
      if (config.caFile) {
        try {
          ca = readFileSync(config.caFile, 'utf8');
        } catch (error) {
          throw new Error(`Cannot read UNIFI_CA_FILE ${config.caFile}. This path is read inside the collector container; ` +
            'mount the PEM file there (for example with docker-compose.ca.yml and UNIFI_CA_HOST_FILE).', {cause: error});
        }
        if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error(`UNIFI_CA_FILE ${config.caFile} is not a PEM certificate`);
      }
      const lookup: LookupFunction | undefined = config.connectIp
        ? (_hostname, options, callback) => {
          const address = config.connectIp!;
          const family = isIP(address);
          callback(null, options.all ? [{address, family}] : address, family);
        }
        : undefined;
      const connect = {
        ...(ca ? {ca} : {}),
        ...(lookup ? {lookup} : {})
      };
      this.dispatcher = new Agent({connect});
    }
  }

  async close(): Promise<void> { await this.dispatcher?.close(); }

  private async request(path: string): Promise<unknown> {
    const headers: Record<string, string> = {accept: 'application/json'};
    if (this.config.apiKey) headers['X-API-KEY'] = this.config.apiKey;
    if (this.config.cookie) headers.Cookie = this.config.cookie;
    const response = await this.fetcher(new URL(path, this.config.url), {
      method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000),
      ...(this.dispatcher ? {dispatcher: this.dispatcher} : {})
    });
    if (!response.ok) throw new UnifiHttpError(response.status);
    return response.json() as Promise<unknown>;
  }

  private async getOfficialPages(path: string): Promise<{data: Record<string, unknown>[]}> {
    const sites: Record<string, unknown>[] = [];
    let total: number | null = null;
    for (let page = 0; page < 1000; page++) {
      const offset = sites.length;
      const payload = await this.request(`${path}?offset=${offset}&limit=200`);
      const rows = extractData(payload);
      const wrapper = payload as Record<string, unknown>;
      if (wrapper.offset !== offset || wrapper.count !== rows.length || typeof wrapper.totalCount !== 'number' || !Number.isSafeInteger(wrapper.totalCount) || wrapper.totalCount < 0) {
        throw new Error('Invalid official site page');
      }
      if (total === null) total = wrapper.totalCount as number;
      if (total !== wrapper.totalCount || sites.length + rows.length > total || (rows.length === 0 && sites.length < total)) {
        throw new Error('Incomplete official site pagination');
      }
      sites.push(...rows);
      if (sites.length === total) return {data: sites};
    }
    throw new Error('Official site page limit exceeded');
  }
  getOfficialSites(): Promise<{data: Record<string, unknown>[]}> {
    return this.getOfficialPages('/proxy/network/integration/v1/sites');
  }
  getOfficialDevices(siteId: string): Promise<{data: Record<string, unknown>[]}> {
    if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new Error('Invalid site ID');
    return this.getOfficialPages(`/proxy/network/integration/v1/sites/${siteId}/devices`);
  }
  getOfficialConnectedClients(siteId: string): Promise<{data: Record<string, unknown>[]}> {
    if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new Error('Invalid site ID');
    return this.getOfficialPages(`/proxy/network/integration/v1/sites/${siteId}/clients`);
  }
  getInternalClients(): Promise<unknown> { return this.request(`/proxy/network/api/s/${this.config.site}/stat/sta`); }

  /** Read-only, internal DPI app traffic. Period semantics and Internet scope require separate validation. */
  async getDpiTraffic(start: Date, end: Date, mac?: string): Promise<DpiClientUsage[]> {
    const from = start.getTime();
    const to = end.getTime();
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 86400000) {
      throw new Error('Invalid DPI time range');
    }
    if (mac !== undefined && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) throw new Error('Invalid DPI client MAC');
    const suffix = mac ? `/${mac.toLowerCase()}` : '';
    const path = `/proxy/network/v2/api/site/${this.config.site}/traffic${suffix}?start=${from}&end=${to}`;
    const rows = parseDpiTraffic(await this.request(path));
    if (mac && (rows.length > 1 || rows.some(row => row.mac !== mac.toLowerCase()))) {
      throw new Error('Unexpected DPI client response');
    }
    return rows;
  }
}

export function unifiConfigFromEnv(): UnifiConfig {
  if (!process.env.UNIFI_URL) throw new Error('UNIFI_URL is required');
  return {url: process.env.UNIFI_URL, site: process.env.UNIFI_SITE ?? 'default', apiKey: process.env.UNIFI_API_KEY,
    cookie: process.env.UNIFI_COOKIE, connectIp: process.env.UNIFI_CONNECT_IP, caFile: process.env.UNIFI_CA_FILE};
}

export function extractData(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') throw new Error('Unexpected UniFi response');
  const wrapper = payload as Record<string, unknown>;
  const rows = Array.isArray(wrapper.data) ? wrapper.data : null;
  if (!rows || !rows.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error('UniFi response did not contain a complete data array');
  }
  if (wrapper.meta && typeof wrapper.meta === 'object' && (wrapper.meta as Record<string, unknown>).rc !== 'ok') {
    throw new Error('UniFi response reported failure');
  }
  return rows as Record<string, unknown>[];
}

/** The internal client endpoint uses an rc envelope, unlike official paginated endpoints. */
export function extractInternalClients(payload: unknown): Record<string, unknown>[] {
  const rows = extractData(payload);
  const wrapper = payload as Record<string, unknown>;
  const meta = wrapper.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || (meta as Record<string, unknown>).rc !== 'ok') {
    throw new Error('Invalid internal client response status');
  }
  const reported = meta as Record<string, unknown>;
  for (const count of [reported.count, reported.totalCount, wrapper.totalCount]) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count !== rows.length)) {
      throw new Error('Partial client page');
    }
  }
  return rows;
}
