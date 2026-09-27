import { describe, expect, it, vi } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { UnifiClient, extractData, extractInternalClients } from './index';

describe('extractData', () => {
  it('accepts a complete successful envelope', () => expect(extractData({meta:{rc:'ok'},data:[{mac:'a'}]})).toHaveLength(1));
  it('rejects missing or unsuccessful data instead of treating clients as offline', () => {
    expect(() => extractData({meta:{rc:'ok'}})).toThrow();
    expect(() => extractData({meta:{rc:'error'},data:[]})).toThrow();
    expect(() => extractData({data:[null]})).toThrow();
  });
});

describe('internal client envelope', () => {
  it('accepts a verified empty or complete response', () => {
    expect(extractInternalClients({meta: {rc: 'ok'}, data: []})).toEqual([]);
    expect(extractInternalClients({meta: {rc: 'ok', count: 1, totalCount: 1}, data: [{mac: 'a'}]}))
      .toHaveLength(1);
  });
  it('rejects missing status and truncated counts before changing client state', () => {
    expect(() => extractInternalClients({data: []})).toThrow('Invalid internal client response status');
    expect(() => extractInternalClients({meta: {rc: 'error'}, data: []})).toThrow();
    for (const envelope of [
      {meta: {rc: 'ok', count: 2}, data: [{}]},
      {meta: {rc: 'ok', count: '1'}, data: [{}]},
      {meta: {rc: 'ok', totalCount: 2}, data: [{}]},
      {meta: {rc: 'ok'}, totalCount: 2, data: [{}]}
    ]) expect(() => extractInternalClients(envelope)).toThrow('Partial client page');
  });
});

describe('official site pagination', () => {
  it('reads every page and rejects a missing page', async () => {
    const fetchMock = vi.fn(async (input: URL) => {
      const offset = Number(input.searchParams.get('offset'));
      const count = offset === 0 ? 200 : 1;
      return new Response(JSON.stringify({offset, count, totalCount: 201, data: Array.from({length: count}, (_, n) => ({id: `${offset+n}`}))}));
    });
    const client = new UnifiClient({url: 'https://unifi.example', site: 'default', apiKey: 'test'}, fetchMock as unknown as typeof undiciFetch);
    expect(extractData(await client.getOfficialSites())).toHaveLength(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({offset: 0, count: 200, totalCount: 201, data: [{id: 'one'}]})));
    await expect(client.getOfficialSites()).rejects.toThrow('Invalid official site page');
  });
});

describe('UniFi request failures', () => {
  it('does not forward credentials through a redirect', async () => {
    const fetchMock = vi.fn(async (_input: URL, options: {redirect?: string}) => {
      expect(options.redirect).toBe('manual');
      return new Response(null, {status: 302, headers: {location: 'https://elsewhere.example/login'}});
    });
    const client = new UnifiClient({url: 'https://unifi.example', site: 'default', apiKey: 'test'},
      fetchMock as unknown as typeof undiciFetch);
    try {
      await expect(client.getInternalClients()).rejects.toMatchObject({status: 302});
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {await client.close();}
  });
  it.each([401, 429])('preserves HTTP %i for collector backoff and status', async status => {
    const fetchMock = vi.fn(async () => new Response('{}', {status}));
    const client = new UnifiClient({url: 'https://unifi.example', site: 'default', apiKey: 'test'},
      fetchMock as unknown as typeof undiciFetch);
    try {
      await expect(client.getInternalClients()).rejects.toMatchObject({status});
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {await client.close();}
  });
  it('ends an unresponsive request at the configured timeout', async () => {
    const fetchMock = vi.fn((_input: URL, options: {signal?: AbortSignal}) => new Promise<Response>((_resolve, reject) => {
      const signal = options.signal;
      if (!signal) throw new Error('Missing timeout signal');
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    }));
    const client = new UnifiClient({url: 'https://unifi.example', site: 'default', apiKey: 'test', timeoutMs: 10},
      fetchMock as unknown as typeof undiciFetch);
    try {await expect(client.getInternalClients()).rejects.toMatchObject({name: 'TimeoutError'});}
    finally {await client.close();}
  });
});
