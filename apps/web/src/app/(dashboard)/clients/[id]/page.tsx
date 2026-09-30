import Link from 'next/link';
import {notFound} from 'next/navigation';
import {isUuid} from '@utm/contracts';
import {getAgentStatus, getClient, getClientAgentToday, getClientConnection, getClientRecentSamples} from '@/lib/queries';
import {getAvailableClientScopes, getClientTraffic, type MeasuredScope} from '@/lib/traffic';
import {TrafficChart} from '@/components/traffic-chart';
import {TrafficPeriodSelect} from '@/components/traffic-period-select';
import {ClientLiveTraffic} from '@/components/live-traffic';
import {dateTime, scopeLabels as labels} from '@/lib/format';
import {ArrowLeft, Activity} from 'lucide-react';

export const dynamic = 'force-dynamic';
const periods = { '30m': 30 * 60000, '1h': 3600000, '3h': 3 * 3600000, '6h': 6 * 3600000,
  '12h': 12 * 3600000, '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 } as const;
const scopeLabels = labels as Record<MeasuredScope, string>;
const scopeNotes: Record<MeasuredScope, string> = {
  internet: '게이트웨이가 직접 센 값입니다. 인터넷으로 나가고 들어온 트래픽만 포함합니다.',
  lan: '게이트웨이가 직접 센 값입니다. 다른 네트워크나 게이트웨이와 주고받은 트래픽이며, 같은 네트워크 안에서 스위치로만 오간 통신은 포함되지 않습니다.',
  combined: '확인된 사용량만 합산합니다.',
  reported: 'UniFi가 알려준 트래픽 정보를 합산한 값입니다. 인터넷과 LAN 포함 범위 및 실제 전송량과의 오차는 확인하지 않았습니다.'
};

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
  const [device, samples, scopes, agent, today] = await Promise.all([
    getClientConnection(client.deviceId), getClientRecentSamples(id), getAvailableClientScopes(id), getAgentStatus(),
    getClientAgentToday(id)
  ]);
  const scope = scopes.find(item => item === query.scope) ?? scopes[0];
  const end = new Date();
  const start = new Date(end.getTime() - periods[period]);
  const traffic = scope ? await getClientTraffic(id, scope, start, end) : null;
  return <div className="space-y-6">
    <div><Link href="/clients" className="text-link mb-2"><ArrowLeft size={15} aria-hidden="true" /> 클라이언트 목록</Link><div className="page-heading mb-0"><div><p className="eyebrow mb-2">CLIENT DETAIL</p><h1>{client.name ?? client.mac}</h1><p>{client.ip ?? 'IP 미확인'} · {client.connection === 'wired' ? '유선' : client.connection === 'wireless' ? '무선' : '연결 방식 미확인'}</p></div><span className={`pill ${client.online ? 'pill--good' : ''}`}>{client.online === null ? '상태 미확인' : client.online ? '온라인' : '오프라인'}</span></div></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <section className="panel"><p className="eyebrow">CONNECTION</p><h2 className="panel-title mt-1">연결 정보</h2><dl className="detail-list mt-4"><dt>MAC</dt><dd>{client.mac}</dd><dt>상태</dt><dd>{client.online === null ? '미확인' : client.online ? '온라인' : '오프라인'}</dd><dt>연결 장비</dt><dd>{device?.name ?? device?.model ?? '미확인'}</dd><dt>최근 연결</dt><dd>{dateTime(client.lastSeenAt)}</dd>
        {client.connection === 'wireless' && <><dt className="muted">무선 신호</dt><dd>{client.online && client.wirelessSignalDbm !== null ? `${client.wirelessSignalDbm} dBm` : '미확인'}</dd><dt className="muted">무선 잡음</dt><dd>{client.online && client.wirelessNoiseDbm !== null ? `${client.wirelessNoiseDbm} dBm` : '미확인'}</dd><dt className="muted">신호 수집</dt><dd>{client.online ? dateTime(client.wirelessObservedAt) : '—'}</dd></>}
      </dl>{client.connection === 'wireless' && <p className="mt-3 text-xs muted">마지막 수집값이며 실시간 신호가 아닙니다.</p>}</section>
      <section className="panel"><p className="eyebrow">USAGE</p><h2 className="panel-title mt-1">트래픽 사용량</h2>{samples.length ? <><div className="mt-5 flex items-center gap-3 rounded-2xl p-4" style={{background: 'var(--surface-alt)'}}><span className="metric-icon"><Activity size={19} aria-hidden="true" /></span><div><p className="font-bold">트래픽 정보 {new Set(samples.map(sample => sample.source)).size}종</p><p className="mt-1 text-xs muted">마지막 수집 {dateTime(samples[0].collectedAt)}</p></div></div>{!traffic && <p className="mt-4 text-sm muted">아직 표시할 사용량이 없습니다.</p>}</> : <p className="mt-4 text-sm muted">이 클라이언트의 트래픽 정보가 아직 수집되지 않았습니다.</p>}</section>
    </div>
    {agent && <ClientLiveTraffic clientId={id} connected={agent.connected} today={today} />}
    {traffic && <section className="panel space-y-4"><div className="section-header"><div><p className="eyebrow">TRAFFIC HISTORY</p><h2 className="panel-title mt-1">{scopeLabels[scope]} 트래픽</h2><p className="panel-subtitle">{scopeNotes[scope]}</p></div></div>
      {scopes.length > 1 && <nav aria-label="트래픽 범위" className="flex flex-wrap gap-2">{scopes.map(item => <Link key={item} href={`/clients/${id}?period=${period}&scope=${item}`} className="scope-link" aria-current={item === scope ? 'page' : undefined}>{scopeLabels[item]}</Link>)}</nav>}
      <TrafficPeriodSelect clientId={id} period={period} scope={scope} />
      <TrafficChart data={traffic} gatewayMeasured={scope === 'internet' || scope === 'lan'} />
    </section>}
  </div>;
}
