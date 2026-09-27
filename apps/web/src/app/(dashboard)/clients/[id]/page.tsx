import Link from 'next/link';
import {notFound} from 'next/navigation';
import {isUuid} from '@utm/contracts';
import {getClient, getClientConnection, getClientRecentSamples} from '@/lib/queries';
import {getAvailableClientScopes, getClientTraffic, type MeasuredScope} from '@/lib/traffic';
import {TrafficChart} from '@/components/traffic-chart';
import {TrafficPeriodSelect} from '@/components/traffic-period-select';
import {dateTime} from '@/lib/format';

export const dynamic = 'force-dynamic';
const periods = { '30m': 30 * 60000, '1h': 3600000, '3h': 3 * 3600000, '6h': 6 * 3600000,
  '12h': 12 * 3600000, '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 } as const;
const scopeLabels: Record<MeasuredScope, string> = {internet: '인터넷', combined: '전체 연결', lan: 'LAN', reported: '컨트롤러 보고'};

export default async function ClientPage({params, searchParams}: {
  params: Promise<{id: string}>;
  searchParams: Promise<{period?: string; scope?: string}>;
}) {
  const {id} = await params;
  if (!isUuid(id)) notFound();
  const client = await getClient(id);
  if (!client) notFound();
  const query = await searchParams;
  const period = query.period && Object.hasOwn(periods, query.period) ? query.period as keyof typeof periods : '24h';
  const [device, samples, scopes] = await Promise.all([
    getClientConnection(client.deviceId), getClientRecentSamples(id), getAvailableClientScopes(id)
  ]);
  const scope = scopes.find(item => item === query.scope) ?? scopes[0];
  const end = new Date();
  const start = new Date(end.getTime() - periods[period]);
  const traffic = scope ? await getClientTraffic(id, scope, start, end) : null;
  return <div className="space-y-6">
    <div><h1 className="text-3xl font-semibold">{client.name ?? client.mac}</h1><p className="mt-2 muted">{client.ip ?? 'IP 미확인'} · {client.connection === 'wired' ? '유선' : client.connection === 'wireless' ? '무선' : '연결 방식 미확인'}</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <section className="panel"><h2 className="font-semibold">연결 정보</h2><dl className="mt-4 grid grid-cols-2 gap-2 text-sm"><dt className="muted">MAC</dt><dd>{client.mac}</dd><dt className="muted">상태</dt><dd>{client.online === null ? '미확인' : client.online ? '온라인' : '오프라인'}</dd><dt className="muted">연결 장비</dt><dd>{device?.name ?? device?.model ?? '미확인'}</dd><dt className="muted">최근 연결</dt><dd>{dateTime(client.lastSeenAt)}</dd>
        {client.connection === 'wireless' && <><dt className="muted">무선 신호</dt><dd>{client.online && client.wirelessSignalDbm !== null ? `${client.wirelessSignalDbm} dBm` : '미확인'}</dd><dt className="muted">무선 잡음</dt><dd>{client.online && client.wirelessNoiseDbm !== null ? `${client.wirelessNoiseDbm} dBm` : '미확인'}</dd><dt className="muted">신호 수집</dt><dd>{client.online ? dateTime(client.wirelessObservedAt) : '—'}</dd></>}
      </dl>{client.connection === 'wireless' && <p className="mt-3 text-xs muted">마지막 수집값이며 실시간 신호가 아닙니다.</p>}</section>
      <section className="panel"><h2 className="font-semibold">트래픽 사용량</h2>{samples.length ? <><p className="mt-4 text-sm">트래픽 정보 {new Set(samples.map(sample => sample.source)).size}종 · 마지막 수집 {dateTime(samples[0].collectedAt)}</p>{!traffic && <p className="mt-2 text-sm muted">아직 표시할 사용량이 없습니다.</p>}</> : <p className="mt-4 text-sm muted">이 클라이언트의 트래픽 정보가 아직 수집되지 않았습니다.</p>}</section>
    </div>
    {traffic && <section className="panel space-y-4"><div><h2 className="font-semibold">{scopeLabels[scope]} 트래픽</h2><p className="mt-1 text-sm muted">{scope === 'reported' ? 'UniFi가 알려준 트래픽 정보를 합산한 값입니다. 인터넷과 LAN 포함 범위 및 실제 전송량과의 오차는 확인하지 않았습니다.' : '확인된 사용량만 합산합니다.'}</p></div>
      {scopes.length > 1 && <nav aria-label="트래픽 범위" className="flex flex-wrap gap-2">{scopes.map(item => <Link key={item} href={`/clients/${id}?period=${period}&scope=${item}`} className={`min-h-11 rounded-xl px-4 py-3 text-sm ${item === scope ? 'bg-blue-600 text-white' : 'border border-current/20'}`}>{scopeLabels[item]}</Link>)}</nav>}
      <TrafficPeriodSelect clientId={id} period={period} scope={scope} />
      <TrafficChart data={traffic} />
    </section>}
  </div>;
}
