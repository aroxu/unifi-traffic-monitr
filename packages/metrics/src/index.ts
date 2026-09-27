export type TrafficScope = 'internet' | 'lan' | 'combined' | 'reported' | 'unknown';
export type Direction = 'upload' | 'download' | 'rx' | 'tx';
export type CounterQuality = 'valid' | 'baseline' | 'reset' | 'gap' | 'unsupported';

export interface CounterObservation {
  value: bigint;
  observedAt: Date;
  source: string;
  scope: TrafficScope;
  direction: Direction;
  sessionKey: string | null;
}

export interface CounterDelta {
  quality: CounterQuality;
  bytes: bigint | null;
  start: Date | null;
  end: Date;
  advanceCheckpoint: boolean;
}

/** Only comparable cumulative counters may contribute to usage. */
export function calculateDelta(previous: CounterObservation | null, current: CounterObservation,
  maxGapMs = 10 * 60 * 1000): CounterDelta {
  if (current.value < 0n || !Number.isFinite(current.observedAt.getTime())) {
    throw new Error('Invalid counter observation');
  }
  if (!Number.isSafeInteger(maxGapMs) || maxGapMs < 1000) throw new Error('Invalid maximum observation gap');
  if (!previous) return { quality: 'baseline', bytes: null, start: null, end: current.observedAt, advanceCheckpoint: true };
  const start = previous.observedAt;
  if (current.observedAt <= start) return { quality: 'gap', bytes: null, start, end: current.observedAt, advanceCheckpoint: false };
  if (previous.source !== current.source || previous.scope !== current.scope || previous.direction !== current.direction || previous.sessionKey !== current.sessionKey) {
    return { quality: 'baseline', bytes: null, start, end: current.observedAt, advanceCheckpoint: true };
  }
  if (current.value < previous.value) return { quality: 'reset', bytes: null, start, end: current.observedAt, advanceCheckpoint: true };
  if (current.observedAt.getTime() - start.getTime() > maxGapMs) {
    return { quality: 'gap', bytes: null, start, end: current.observedAt, advanceCheckpoint: true };
  }
  return { quality: 'valid', bytes: current.value - previous.value, start, end: current.observedAt, advanceCheckpoint: true };
}

export function decimalBigint(value: bigint): string { return value.toString(10); }

export interface BucketAllocation {
  bucketStart: Date;
  bytes: bigint;
  observedSeconds: number;
}

/** Split one measured interval over UTC buckets without losing integer bytes. */
export function allocateInterval(bytes: bigint, start: Date, end: Date, bucketSeconds: number): BucketAllocation[] {
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (bytes < 0n || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs ||
      !Number.isSafeInteger(bucketSeconds) || bucketSeconds < 1 || bucketSeconds > 86400) {
    throw new Error('Invalid interval allocation');
  }
  const bucketMs = bucketSeconds * 1000;
  const duration = BigInt(endMs - startMs);
  const allocations: BucketAllocation[] = [];
  const overlaps: number[] = [];
  for (let bucket = Math.floor(startMs / bucketMs) * bucketMs; bucket < endMs; bucket += bucketMs) {
    const from = Math.max(startMs, bucket);
    const to = Math.min(endMs, bucket + bucketMs);
    if (to <= from) continue;
    const before = bytes * BigInt(from - startMs) / duration;
    const after = bytes * BigInt(to - startMs) / duration;
    overlaps.push(to - from);
    allocations.push({bucketStart: new Date(bucket), bytes: after - before, observedSeconds: 0});
  }
  // Round the interval once, then assign whole seconds to buckets. Rounding
  // each overlap separately can make a 30-second interval look like 31 seconds.
  const targetSeconds = Math.max(allocations.length, Math.round((endMs - startMs) / 1000));
  const fractions = overlaps.map((overlap, index) => ({index, fraction: overlap % 1000}));
  let unassigned = targetSeconds;
  for (let index = 0; index < allocations.length; index++) {
    allocations[index].observedSeconds = Math.floor(overlaps[index] / 1000);
    unassigned -= allocations[index].observedSeconds;
  }
  fractions.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < unassigned; index++) allocations[fractions[index % fractions.length].index].observedSeconds++;
  // Every bucket with bytes must stay visible to queries that require a
  // positive observation duration. Borrow from the largest other bucket.
  for (const allocation of allocations) {
    if (allocation.observedSeconds > 0) continue;
    const donor = allocations.reduce<BucketAllocation | null>((best, candidate) =>
      candidate.observedSeconds > 1 && (!best || candidate.observedSeconds > best.observedSeconds) ? candidate : best, null);
    if (donor) {donor.observedSeconds--; allocation.observedSeconds++;}
  }
  return allocations;
}
