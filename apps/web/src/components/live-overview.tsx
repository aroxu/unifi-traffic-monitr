'use client';

import {useEffect, useState} from 'react';
import {QueryClient, QueryClientProvider, useQuery} from '@tanstack/react-query';
import {Button, Card} from '@heroui/react';
import Link from 'next/link';
import {ArrowUpRight, DatabaseZap, RadioTower, UsersRound} from 'lucide-react';
import {dateTime, runStatus, scopeLabels} from '@/lib/format';
import {formatUsage, TrafficChart, type TrafficData} from '@/components/traffic-chart';
import {LiveTrafficCard} from '@/components/live-traffic';

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
  agent: {connected: boolean; version: string | null; lastFrameAt: Date | string | null; lastError: string | null} | null;
  clientLabels: Record<string, string>;
};

async function fetchOverview(): Promise<Overview> {
  const response = await fetch('/api/overview', {cache: 'no-store', credentials: 'same-origin'});
  if (!response.ok) throw new Error(`Overview HTTP ${response.status}`);
  return response.json() as Promise<Overview>;
}

function OverviewContents({initialData}: {initialData: Overview}) {
  const {data, isError, refetch} = useQuery({
    queryKey: ['overview'], queryFn: fetchOverview, initialData,
    staleTime: 5000, refetchInterval: 60000, refetchIntervalInBackground: false,
    refetchOnWindowFocus: true, retry: 1
  });
  useEffect(() => {
    const refresh = () => { void refetch(); };
    window.addEventListener('utm:collection', refresh);
    return () => window.removeEventListener('utm:collection', refresh);
  }, [refetch]);
  const latestTime = data.latestRun?.finishedAt ? new Date(data.latestRun.finishedAt) : null;
  const stale = latestTime ? Date.now() - latestTime.getTime() > 90000 : false;
  const withoutCounters = data.counterClientCount !== null && data.latestRun?.clientCount !== null &&
    data.latestRun?.clientCount !== undefined
    ? Math.max(0, data.latestRun.clientCount - data.counterClientCount) : null;
  const scopeLabel = scopeLabels[data.traffic?.scope ?? 'combined'];
  const running = !isError && !stale && data.latestRun?.status !== 'error' && data.latestRun !== null;
  return <div className="space-y-5">
    <section className="overview-hero">
      <div><div className="eyebrow">NETWORK OVERVIEW</div><h1>네트워크 한눈에 보기</h1>
        <p>마지막으로 저장된 수집 결과를 바탕으로 표시합니다.</p></div>
      <Link href="/settings">수집 상태 보기 <ArrowUpRight size={15} aria-hidden="true" /></Link>
    </section>
    {isError && <div role="alert" className="panel flex flex-wrap items-center gap-3 text-sm"><span>최신 상태를 읽지 못했습니다. 마지막으로 받은 값을 표시합니다.</span><Button size="sm" variant="secondary" onPress={() => void refetch()}>다시 읽기</Button></div>}
    {data.agent && <LiveTrafficCard clientLabels={data.clientLabels} connected={data.agent.connected} />}
    <div className="metric-grid">
      <Card className="metric-card"><Card.Header><div className="metric-icon"><UsersRound size={19} aria-hidden="true" /></div><Card.Title>클라이언트</Card.Title></Card.Header><Card.Content><p className="metric-value number">{data.clientCount}<span className="ml-1 text-base font-semibold">대</span></p><p className="metric-caption">{data.onlineCount === null || data.offlineCount === null ? '온라인 상태 미확인' : `온라인 ${data.onlineCount}대 · 오프라인 ${data.offlineCount}대`}</p></Card.Content></Card>
      <Card className="metric-card"><Card.Header><div className="metric-icon"><DatabaseZap size={19} aria-hidden="true" /></div><Card.Title>최근 트래픽 정보</Card.Title></Card.Header><Card.Content><p className="metric-value number">{data.rawCounterCount ?? '—'}{data.rawCounterCount !== null && <span className="ml-1 text-base font-semibold">건</span>}</p><p className="metric-caption">{data.latestRun?.status === 'error' ? '최근 수집 실패로 확인할 수 없습니다' : data.rawCounterCount === null ? '첫 수집을 기다리는 중입니다' : '이번 수집에서 받은 정보'}{withoutCounters ? ` · 확인하지 못한 연결 기기 ${withoutCounters}대` : ''}</p></Card.Content></Card>
      <Card className="metric-card"><Card.Header><div className="metric-icon"><RadioTower size={19} aria-hidden="true" /></div><Card.Title>최근 수집</Card.Title></Card.Header><Card.Content><p className="metric-value text-[1.45rem]">{runStatus(data.latestRun?.status)}</p><p className="metric-caption">{dateTime(latestTime)}{stale ? ' · 90초 이상 지연' : ''}</p></Card.Content></Card>
    </div>
    {data.traffic && <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(270px,.8fr)]">
      <section className="panel"><div className="section-header"><div><p className="eyebrow">TRAFFIC</p><h2 className="panel-title mt-1">최근 24시간 {scopeLabel} 트래픽</h2></div><span className="pill pill--good">{scopeLabel}</span></div>
        {data.traffic.scope === 'reported' && <p className="text-sm muted">UniFi가 알려준 트래픽 정보 기준입니다. 인터넷·LAN 포함 범위와 실제 전송량의 오차는 확인하지 않았습니다.</p>}
        {(data.traffic.scope === 'internet' || data.traffic.scope === 'lan') && <p className="text-sm muted">게이트웨이가 직접 센 값입니다. 같은 네트워크 안에서 스위치로만 오간 통신은 게이트웨이를 지나지 않아 포함되지 않습니다.</p>}
        <TrafficChart data={data.traffic} gatewayMeasured={data.traffic.scope === 'internet' || data.traffic.scope === 'lan'} /></section>
      <section className="panel"><div className="section-header"><div><p className="eyebrow">TOP CLIENTS</p><h2 className="panel-title mt-1">상위 클라이언트</h2></div></div>
        {data.traffic.topClients.length > 0 ? <ul>{data.traffic.topClients.map((client, index) => <li key={client.id}>
          <Link href={`/clients/${client.id}`} className="top-client-row"><span className="flex min-w-0 items-center gap-2"><span className="rank">{index + 1}</span><span className="truncate">{client.name ?? client.mac}</span></span><strong className="number shrink-0">{formatUsage(client.totalBytes)}</strong></Link>
        </li>)}</ul> : <p className="text-sm muted">표시할 클라이언트가 없습니다.</p>}</section>
    </div>}
    <section className="panel"><div className="section-header"><div><p className="eyebrow">COLLECTION</p><h2 className="panel-title mt-1">연결 상태</h2></div><span className={`pill ${running ? 'pill--good' : 'pill--warn'}`}>{isError ? '조회 오류' : stale ? '수집 지연' : data.latestRun?.status === 'error' ? '수집 오류' : data.latestRun ? '최근 수집 완료' : '수집 대기'}</span></div>
      {data.sites.length === 0 ? <p className="text-sm muted">등록된 사이트가 없습니다. UCG 접근 정보를 로컬에 설정하고 PoC를 실행해 원본 필드를 검증하세요.</p> :
        <p className="text-sm muted">사이트: {data.sites.map(site => site.label).join(', ')}</p>}
      <p className="mt-2 text-sm muted">{data.hasMeasuredUsage ? '사용량 기록이 있습니다. 클라이언트 상세에서 기간별 사용량을 확인하세요.' : '첫 사용량 구간이 쌓이면 기간별 결과를 표시합니다.'}</p>
      <Link className="text-link mt-2" href="/settings">수집 상태 보기 <ArrowUpRight size={15} aria-hidden="true" /></Link>
    </section>
  </div>;
}

export function LiveOverview({initialData}: {initialData: Overview}) {
  const [queryClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient}><OverviewContents initialData={initialData} /></QueryClientProvider>;
}
