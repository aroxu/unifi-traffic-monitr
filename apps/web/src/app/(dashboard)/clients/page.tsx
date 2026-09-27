import Link from 'next/link';
import { clientListQuerySchema } from '@utm/contracts';
import { getClients, getDevices } from '@/lib/queries';
import { dateTime } from '@/lib/format';
import {ClientFilters} from '@/components/client-filters';
import {ClientPageSize} from '@/components/client-page-size';
export const dynamic = 'force-dynamic';
export default async function ClientsPage({searchParams}: {searchParams: Promise<Record<string, string | undefined>>}) {
  const query = clientListQuerySchema.parse(await searchParams);
  const [data, devices] = await Promise.all([getClients(query), getDevices()]);
  const pageHref = (page: number) => {
    const params = new URLSearchParams({q: query.q, connection: query.connection, sort: query.sort, page: String(page), limit: String(query.limit)});
    if (query.deviceId) params.set('deviceId', query.deviceId);
    return `/clients?${params}`;
  };
  return <div className="space-y-6"><div><h1 className="text-3xl font-semibold">클라이언트</h1><p className="mt-2 muted">수집된 클라이언트 {data.total}대</p></div>
    <ClientFilters key={`${query.q}:${query.connection}:${query.deviceId ?? ''}:${query.sort}:${query.limit}`} query={query} devices={devices} />
    {data.rows.length === 0 ? <section className="panel muted">표시할 클라이언트가 없습니다. 수집 시작 전이거나 검색 결과가 없습니다.</section> :
      <div className="grid gap-3">{data.rows.map(client => <Link key={client.id} href={`/clients/${client.id}`} className="panel block hover:border-blue-400 focus-visible:outline-2">
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{client.name ?? client.mac}</h2><p className="mt-1 text-sm muted">{client.ip ?? 'IP 미확인'} · {client.connection === 'wired' ? '유선' : client.connection === 'wireless' ? '무선' : '연결 방식 미확인'}</p></div><span className="text-sm">{client.online === null ? '상태 미확인' : client.online ? '온라인' : '오프라인'}</span></div>
        <p className="mt-2 text-xs muted">연결 장비 {client.deviceName ?? '미확인'}</p>
        <p className="mt-3 text-xs muted">최근 연결 {dateTime(client.lastSeenAt)} · {client.measured ? '사용량 기록 있음' : '사용량 확인 대기'}</p>
      </Link>)}</div>}
    <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-end sm:justify-between"><ClientPageSize value={query.limit} /><nav aria-label="클라이언트 페이지 이동" className="flex items-center gap-3"><span className={query.page > 1 ? '' : 'muted'}>{query.page > 1 ? <Link href={pageHref(query.page - 1)}>이전</Link> : '이전'}</span><span aria-hidden="true" className="muted">-</span><span aria-current="page">{query.page} 페이지</span><span aria-hidden="true" className="muted">-</span><span className={query.page * query.limit < data.total ? '' : 'muted'}>{query.page * query.limit < data.total ? <Link href={pageHref(query.page + 1)}>다음</Link> : '다음'}</span></nav></div>
  </div>;
}
