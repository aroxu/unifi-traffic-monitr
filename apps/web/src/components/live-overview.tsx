'use client';

import {useState} from 'react';
import {QueryClient, QueryClientProvider, useQuery} from '@tanstack/react-query';
import {Button, Card} from '@heroui/react';
import Link from 'next/link';
import {dateTime, runStatus} from '@/lib/format';
import {formatUsage, TrafficChart, type TrafficData} from '@/components/traffic-chart';

type Overview = {
  sites: {id: string; label: string}[];
  clientCount: number;
  onlineCount: number | null;
  offlineCount: number | null;
  rawCounterCount: number | null;
  counterClientCount: number | null;
  hasMeasuredUsage: boolean;
  traffic: (TrafficData & {scope: 'internet' | 'combined' | 'lan' | 'reported';
    topClients: {id: string; name: string | null; mac: string; totalBytes: string}[]}) | null;
  latestRun: {status: string; finishedAt: Date | string | null; clientCount: number | null} | null;
};

async function fetchOverview(): Promise<Overview> {
  const response = await fetch('/api/overview', {cache: 'no-store', credentials: 'same-origin'});
  if (!response.ok) throw new Error(`Overview HTTP ${response.status}`);
  return response.json() as Promise<Overview>;
}

function OverviewContents({initialData}: {initialData: Overview}) {
  const {data, isError, refetch} = useQuery({
    queryKey: ['overview'], queryFn: fetchOverview, initialData,
    staleTime: 5000, refetchInterval: 10000, refetchIntervalInBackground: false,
    refetchOnWindowFocus: true, retry: 1
  });
  const latestTime = data.latestRun?.finishedAt ? new Date(data.latestRun.finishedAt) : null;
  const stale = latestTime ? Date.now() - latestTime.getTime() > 90000 : false;
  const withoutCounters = data.counterClientCount !== null && data.latestRun?.clientCount !== null &&
    data.latestRun?.clientCount !== undefined
    ? Math.max(0, data.latestRun.clientCount - data.counterClientCount) : null;
  const scopeLabel = data.traffic?.scope === 'internet' ? '인터넷' : data.traffic?.scope === 'lan' ? 'LAN' : data.traffic?.scope === 'reported' ? '컨트롤러 보고' : '전체 연결';
  return <div className="space-y-6">
    <div><h1 className="text-3xl font-semibold">개요</h1><p className="mt-2 muted">마지막으로 저장된 수집 결과를 표시합니다.</p></div>
    {isError && <div role="alert" className="panel flex flex-wrap items-center gap-3 text-sm"><span>최신 상태를 읽지 못했습니다. 마지막으로 받은 값을 표시합니다.</span><Button size="sm" variant="secondary" onPress={() => void refetch()}>다시 읽기</Button></div>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card><Card.Header><Card.Title>클라이언트</Card.Title></Card.Header><Card.Content><p className="number text-3xl font-semibold">{data.clientCount}</p><p className="mt-1 text-sm muted">{data.onlineCount === null || data.offlineCount === null ? '온라인 상태 미확인' : `온라인 ${data.onlineCount}대 · 오프라인 ${data.offlineCount}대`}</p></Card.Content></Card>
      <Card><Card.Header><Card.Title>최근 트래픽 정보</Card.Title></Card.Header><Card.Content><p className="number text-3xl font-semibold">{data.rawCounterCount ?? '—'}</p><p className="mt-1 text-sm muted">{data.latestRun?.status === 'error' ? '최근 수집 실패로 확인할 수 없습니다' : data.rawCounterCount === null ? '첫 수집을 기다리는 중입니다' : '이번 수집에서 받은 정보'}{withoutCounters ? ` · 확인하지 못한 연결 기기 ${withoutCounters}대` : ''}</p></Card.Content></Card>
      <Card><Card.Header><Card.Title>최근 수집</Card.Title></Card.Header><Card.Content><p className="text-lg font-semibold">{runStatus(data.latestRun?.status)}</p><p className="mt-1 text-sm muted">{dateTime(latestTime)}{stale ? ' · 90초 이상 지연' : ''}</p></Card.Content></Card>
    </div>
    {data.traffic && <Card><Card.Header><Card.Title>최근 24시간 {scopeLabel} 트래픽</Card.Title></Card.Header>
      <Card.Content>{data.traffic.scope === 'reported' && <p className="text-sm muted">UniFi가 알려준 트래픽 정보 기준입니다. 인터넷·LAN 포함 범위와 실제 전송량의 오차는 확인하지 않았습니다.</p>}<TrafficChart data={data.traffic} />
        {data.traffic.topClients.length > 0 && <div className="mt-6"><h2 className="font-semibold">상위 클라이언트</h2>
          <ul className="mt-2 divide-y divide-current/10">{data.traffic.topClients.map(client => <li key={client.id}>
            <Link href={`/clients/${client.id}`} className="flex min-h-11 items-center justify-between gap-4 py-3 text-sm underline">
              <span className="truncate">{client.name ?? client.mac}</span><span className="number shrink-0">{formatUsage(client.totalBytes)}</span>
            </Link></li>)}</ul>
        </div>}
      </Card.Content></Card>}
    <Card><Card.Header><Card.Title>연결 상태</Card.Title></Card.Header><Card.Content className="space-y-3">
      {data.sites.length === 0 ? <p className="muted">등록된 사이트가 없습니다. UCG 접근 정보를 로컬에 설정하고 PoC를 실행해 원본 필드를 검증하세요.</p> :
        <p className="muted">사이트: {data.sites.map(site => site.label).join(', ')}</p>}
      <p className="text-sm muted">{data.hasMeasuredUsage ? '컨트롤러 보고 사용량 기록이 있습니다. 클라이언트 상세에서 기간별 사용량을 확인하세요.' : '첫 사용량 구간이 쌓이면 기간별 결과를 표시합니다.'}</p>
      <Link className="inline-block rounded-xl px-4 py-3 text-sm underline" href="/settings">수집 상태 보기</Link>
    </Card.Content></Card>
  </div>;
}

export function LiveOverview({initialData}: {initialData: Overview}) {
  const [queryClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient}><OverviewContents initialData={initialData} /></QueryClientProvider>;
}
