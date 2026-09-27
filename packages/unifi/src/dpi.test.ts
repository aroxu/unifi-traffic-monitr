import {describe, expect, it, vi} from 'vitest';
import {fetch as undiciFetch} from 'undici';
import {parseDpiTraffic, UnifiClient} from './index';

const usage = {client: {mac: 'aa:bb:cc:dd:ee:ff'}, usage_by_app: [
  {application: 185, category: 20, bytes_received: 25, bytes_transmitted: '16', total_bytes: 41}
]};

describe('internal DPI response', () => {
  it('preserves integer bytes and rejects incomplete or inconsistent pages', () => {
    expect(parseDpiTraffic({client_usage_by_app: [usage]})).toEqual([{
      mac: 'aa:bb:cc:dd:ee:ff', apps: [{application: 185, category: 20, receivedBytes: 25n, transmittedBytes: 16n}]
    }]);
    for (const payload of [
      {}, {client_usage_by_app: [usage, usage]},
      {client_usage_by_app: [{...usage, usage_by_app: [{...usage.usage_by_app[0], total_bytes: 42}]}]},
      {client_usage_by_app: [{...usage, usage_by_app: [{...usage.usage_by_app[0], bytes_received: 2 ** 53}]}]},
      {client_usage_by_app: [{...usage, usage_by_app: null}]}
    ]) expect(() => parseDpiTraffic(payload)).toThrow();
  });

  it('checks site app totals against all client rows when provided', () => {
    const other = {...usage, client: {mac: '11:22:33:44:55:66'}};
    const total = {application: 185, category: 20, bytes_received: 50, bytes_transmitted: 32, total_bytes: 82};
    expect(parseDpiTraffic({client_usage_by_app: [usage, other], total_usage_by_app: [total]})).toHaveLength(2);
    expect(() => parseDpiTraffic({client_usage_by_app: [usage], total_usage_by_app: [total]}))
      .toThrow('DPI site totals do not match clients');
    expect(() => parseDpiTraffic({client_usage_by_app: [usage], total_usage_by_app: null}))
      .toThrow('Invalid DPI site totals');
  });

  it('bounds time and client identity before querying the read-only path', async () => {
    const fetchMock = vi.fn(async (input: URL, options: {method?: string; redirect?: string}) => {
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('manual');
      expect(input.pathname).toBe('/proxy/network/v2/api/site/default/traffic/aa:bb:cc:dd:ee:ff');
      expect(input.searchParams.get('start')).toBe('1000');
      expect(input.searchParams.get('end')).toBe('2000');
      return new Response(JSON.stringify({client_usage_by_app: [usage]}));
    });
    const client = new UnifiClient({url: 'https://unifi.example', site: 'default', apiKey: 'test'},
      fetchMock as unknown as typeof undiciFetch);
    try {
      expect(await client.getDpiTraffic(new Date(1000), new Date(2000), 'AA:BB:CC:DD:EE:FF')).toHaveLength(1);
      await expect(client.getDpiTraffic(new Date(2000), new Date(1000))).rejects.toThrow('Invalid DPI time range');
      await expect(client.getDpiTraffic(new Date(1000), new Date(2000), 'invalid')).rejects.toThrow('Invalid DPI client MAC');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {await client.close();}
  });

  it('rejects a different client from a filtered response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({client_usage_by_app: [usage]})));
    const client = new UnifiClient({url: 'https://unifi.example', site: 'default', apiKey: 'test'},
      fetchMock as unknown as typeof undiciFetch);
    try {
      await expect(client.getDpiTraffic(new Date(1000), new Date(2000), '11:22:33:44:55:66'))
        .rejects.toThrow('Unexpected DPI client response');
    } finally {await client.close();}
  });
});
