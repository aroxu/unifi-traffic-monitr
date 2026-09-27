import type {CounterObservation, Direction, TrafficScope} from '@utm/metrics';

type Connection = 'wired' | 'wireless';
type SourceDirection = 'rx' | 'tx';
type Mapping = {scope: Exclude<TrafficScope, 'unknown'>; rxDirection: 'upload' | 'download'};
export type CounterMappings = Record<Connection, Mapping | null>;

export function parseCounterMappings(env: NodeJS.ProcessEnv): CounterMappings {
  const result: CounterMappings = {wired: null, wireless: null};
  for (const connection of ['wired', 'wireless'] as const) {
    const prefix = `UNIFI_${connection.toUpperCase()}_`;
    const scope = env[`${prefix}SCOPE`];
    const rxDirection = env[`${prefix}RX_DIRECTION`];
    if (!scope && !rxDirection) continue;
    if ((scope !== 'internet' && scope !== 'lan' && scope !== 'combined' && scope !== 'reported') ||
        (rxDirection !== 'upload' && rxDirection !== 'download')) {
      throw new Error(`Incomplete or invalid ${connection} counter mapping`);
    }
    result[connection] = {scope, rxDirection};
  }
  return result;
}

export function resolvedCounterSemantics(mappings: CounterMappings, connection: Connection, rawDirection: SourceDirection): Pick<CounterObservation, 'scope' | 'direction'> {
  const mapping = mappings[connection];
  if (!mapping) return {scope: 'unknown', direction: rawDirection};
  const opposite: Direction = mapping.rxDirection === 'upload' ? 'download' : 'upload';
  return {scope: mapping.scope, direction: rawDirection === 'rx' ? mapping.rxDirection : opposite};
}
