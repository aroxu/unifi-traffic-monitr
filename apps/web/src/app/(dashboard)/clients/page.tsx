import Link from 'next/link';
import { clientListQuerySchema } from '@utm/contracts';
import { getClients, getDevices } from '@/lib/queries';
import { dateTime } from '@/lib/format';
import {ClientFilters} from '@/components/client-filters';
import {ClientPageSize} from '@/components/client-page-size';
import {ArrowUpRight, Laptop2} from 'lucide-react';
export const dynamic = 'force-dynamic';
export default async function ClientsPage({searchParams}: {searchParams: Promise<Record<string, string | undefined>>}) {
  const query = clientListQuerySchema.parse(await searchParams);
  const [data, devices] = await Promise.all([getClients(query), getDevices()]);
  const pageHref = (page: number) => {
    const params = new URLSearchParams({q: query.q, connection: query.connection, sort: query.sort, page: String(page), limit: String(query.limit)});
    if (query.deviceId) params.set('deviceId', query.deviceId);
    return `/clients?${params}`;
  };
  return <div className="space-y-5"><div className="page-heading"><div><p className="eyebrow mb-2">CLIENTS</p><h1>클라이언트</h1><p>수집된 클라이언트를 검색하고 연결 상태를 확인합니다.</p></div><span className="pill pill--good">전체 {data.total}대</span></div>
    <ClientFilters key={`${query.q}:${query.connection}:${query.deviceId ?? ''}:${query.sort}:${query.limit}`} query={query} devices={devices} />
    {data.rows.length === 0 ? <section className="panel muted">표시할 클라이언트가 없습니다. 수집 시작 전이거나 검색 결과가 없습니다.</section> :
      <div className="grid gap-3">{data.rows.map(client => <Link key={client.id} href={`/clients/${client.id}`} className="client-card">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-3"><span className="metric-icon shrink-0"><Laptop2 size={18} aria-hidden="true" /></span><div className="min-w-0"><h2 className="truncate font-bold">{client.name ?? client.mac}</h2><p className="mt-1 text-xs muted">{client.ip ?? 'IP 미확인'} · {client.connection === 'wired' ? '유선' : client.connection === 'wireless' ? '무선' : '연결 방식 미확인'}</p></div></div><span className={`pill ${client.online ? 'pill--good' : ''}`}>{client.online === null ? '상태 미확인' : client.online ? '온라인' : '오프라인'}</span></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs muted" style={{borderColor: 'var(--line)'}}><span>연결 장비 <strong className="font-semibold" style={{color: 'var(--ink)'}}>{client.deviceName ?? '미확인'}</strong></span><span>최근 연결 {dateTime(client.lastSeenAt)}</span><span>{client.measured ? '사용량 기록 있음' : '사용량 확인 대기'} <ArrowUpRight className="ml-1 inline" size={13} aria-hidden="true" /></span></div>
      </Link>)}</div>}
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><ClientPageSize value={query.limit} /><nav aria-label="클라이언트 페이지 이동" className="pager">{query.page > 1 ? <Link href={pageHref(query.page - 1)}>이전</Link> : <span className="is-disabled">이전</span>}<span aria-current="page">{query.page} 페이지</span>{query.page * query.limit < data.total ? <Link href={pageHref(query.page + 1)}>다음</Link> : <span className="is-disabled">다음</span>}</nav></div>
  </div>;
}
