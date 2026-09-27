import {describe, expect, it} from 'vitest';
import {parseCounterMappings, resolvedCounterSemantics} from './mapping';

describe('explicitly verified counter mappings', () => {
  it('keeps unverified fields raw and maps only configured connection types', () => {
    const mappings = parseCounterMappings({UNIFI_WIRED_SCOPE: 'internet', UNIFI_WIRED_RX_DIRECTION: 'upload'});
    expect(resolvedCounterSemantics(mappings, 'wired', 'rx')).toEqual({scope: 'internet', direction: 'upload'});
    expect(resolvedCounterSemantics(mappings, 'wired', 'tx')).toEqual({scope: 'internet', direction: 'download'});
    expect(resolvedCounterSemantics(mappings, 'wireless', 'rx')).toEqual({scope: 'unknown', direction: 'rx'});
  });
  it('rejects an incomplete mapping instead of silently asserting usage', () => {
    expect(() => parseCounterMappings({UNIFI_WIRED_SCOPE: 'internet'})).toThrow('Incomplete');
    expect(() => parseCounterMappings({UNIFI_WIRELESS_RX_DIRECTION: 'receive'})).toThrow('Incomplete');
  });
});
