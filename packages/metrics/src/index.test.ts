import { describe, expect, it } from 'vitest';
import { allocateInterval, calculateDelta, decimalBigint, type CounterObservation } from './index';

const at = (second: number, value: bigint, overrides: Partial<CounterObservation> = {}): CounterObservation => ({
  value, observedAt: new Date(second * 1000), source: 'sta:rx_bytes', scope: 'unknown', direction: 'download', sessionKey: 'one', ...overrides
});

describe('allocateInterval', () => {
  it('preserves odd integer bytes across the Asia/Seoul midnight boundary', () => {
    const buckets = allocateInterval(101n, new Date('2026-09-25T14:59:30Z'), new Date('2026-09-25T15:00:30Z'), 300);
    expect(buckets.map(bucket => [bucket.bucketStart.toISOString(), bucket.bytes, bucket.observedSeconds])).toEqual([
      ['2026-09-25T14:55:00.000Z', 50n, 30],
      ['2026-09-25T15:00:00.000Z', 51n, 30]
    ]);
  });
  it('conserves values above the JavaScript safe integer limit over several buckets', () => {
    const total = 9007199254740993n;
    const buckets = allocateInterval(total, new Date('2026-09-25T14:30:00Z'), new Date('2026-09-25T16:30:00Z'), 3600);
    expect(buckets.map(bucket => bucket.bytes)).toEqual([total / 4n, total / 2n, total - total * 3n / 4n]);
    expect(buckets.reduce((sum, bucket) => sum + bucket.bytes, 0n)).toBe(total);
    expect(buckets.reduce((sum, bucket) => sum + bucket.observedSeconds, 0)).toBe(7200);
  });
  it('preserves rounded observation time when a polling interval barely crosses a bucket boundary', () => {
    const buckets = allocateInterval(302n, new Date('2026-09-25T14:59:59.900Z'),
      new Date('2026-09-25T15:00:30.100Z'), 300);
    expect(buckets.map(bucket => bucket.bytes)).toEqual([1n, 301n]);
    expect(buckets.map(bucket => bucket.observedSeconds)).toEqual([1, 29]);
    expect(buckets.reduce((sum, bucket) => sum + bucket.observedSeconds, 0)).toBe(30);
  });
  it('keeps exact whole-second allocations at a boundary', () => {
    const buckets = allocateInterval(120n, new Date('2026-09-25T14:59:30Z'),
      new Date('2026-09-25T15:01:30Z'), 300);
    expect(buckets.map(bucket => bucket.observedSeconds)).toEqual([30, 90]);
  });
});

describe('calculateDelta', () => {
  it('counts comparable increasing counters without losing bigint precision', () => {
    expect(calculateDelta(at(1, 9007199254740993n), at(31, 9007199254741093n))).toMatchObject({quality: 'valid', bytes: 100n});
    expect(decimalBigint(9007199254740993n)).toBe('9007199254740993');
  });
  it('does not invent usage on first sample, reset, changed source, changed session, or stale time', () => {
    expect(calculateDelta(null, at(31, 8n)).quality).toBe('baseline');
    expect(calculateDelta(at(1, 8n), at(31, 2n)).quality).toBe('reset');
    expect(calculateDelta(at(1, 8n), at(31, 9n, {source: 'other'})).quality).toBe('baseline');
    expect(calculateDelta(at(1, 8n), at(31, 9n, {sessionKey: 'two'})).quality).toBe('baseline');
    expect(calculateDelta(at(31, 8n), at(31, 9n))).toMatchObject({quality: 'gap', advanceCheckpoint: false});
  });
  it('rebases after a long observation gap without distributing unknown traffic', () => {
    const interrupted = calculateDelta(at(0, 100n), at(601, 300n));
    expect(interrupted).toMatchObject({quality: 'gap', bytes: null, advanceCheckpoint: true});
    expect(calculateDelta(at(601, 300n), at(631, 320n))).toMatchObject({quality: 'valid', bytes: 20n});
    expect(calculateDelta(at(0, 100n), at(601, 50n))).toMatchObject({quality: 'reset', advanceCheckpoint: true});
    expect(calculateDelta(at(0, 100n), at(601, 300n, {sessionKey: 'two'}))).toMatchObject({quality: 'baseline', advanceCheckpoint: true});
  });
});
