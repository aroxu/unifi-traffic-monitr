import {describe, expect, it} from 'vitest';
import {parseClientSnapshot, parseConnectedClientSnapshot, parseDeviceSnapshot} from './snapshot';

const base = {mac: 'AA:BB:CC:DD:EE:FF', is_wired: true, latest_assoc_time: 1700000000};

describe('raw UniFi snapshot parsing', () => {
  it('retains raw counter direction, source, session, and integer precision', () => {
    const parsed = parseClientSnapshot({...base, 'wired-rx_bytes': '9007199254740993', 'wired-tx_bytes': 18});
    expect(parsed.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(parsed.counters).toEqual([
      {source: 'sta:wired-rx_bytes', direction: 'rx', value: 9007199254740993n, sessionKey: new Date(1700000000000).toISOString()},
      {source: 'sta:wired-tx_bytes', direction: 'tx', value: 18n, sessionKey: new Date(1700000000000).toISOString()}
    ]);
  });
  it('accepts clients without counters but rejects partial, negative, fractional, and unsafe counters', () => {
    expect(parseClientSnapshot(base).counters).toEqual([]);
    expect(() => parseClientSnapshot({...base, 'wired-rx_bytes': 1})).toThrow('Partial');
    for (const value of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(() => parseClientSnapshot({...base, 'wired-rx_bytes': value, 'wired-tx_bytes': 1})).toThrow('Invalid');
    }
  });
  it('keeps only plausible wireless signal and noise readings', () => {
    const wireless = {...base, is_wired: false, signal: -67, noise: -96};
    expect(parseClientSnapshot(wireless).wirelessQuality).toEqual({signalDbm: -67, noiseDbm: -96});
    expect(parseClientSnapshot({...wireless, signal: 72, noise: 'unknown'}).wirelessQuality)
      .toEqual({signalDbm: null, noiseDbm: null});
    expect(parseClientSnapshot({...wireless, is_wired: true}).wirelessQuality).toBeNull();
  });
  it('parses verified device identity and online state', () => {
    expect(parseDeviceSnapshot({id: 'device', macAddress: base.mac, state: 'ONLINE'})).toMatchObject({mac: 'aa:bb:cc:dd:ee:ff', online: true});
    expect(() => parseDeviceSnapshot({id: 'device'})).toThrow();
  });
  it('parses official connected client identity without counter assumptions', () => {
    expect(parseConnectedClientSnapshot({macAddress: base.mac, type: 'WIRELESS', uplinkDeviceId: 'ap'}))
      .toMatchObject({mac: 'aa:bb:cc:dd:ee:ff', connection: 'wireless', uplinkDeviceUnifiId: 'ap'});
    expect(() => parseConnectedClientSnapshot({type: 'WIRED'})).toThrow();
  });
});
