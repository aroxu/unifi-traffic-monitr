'use client';

import Link from 'next/link';
import {ArrowDown, ArrowUp, Gauge} from 'lucide-react';
import {bitRate} from '@/lib/format';
import {liveWindowMs, useLive, type LiveStatus} from '@/lib/live-store';

type Point = {at: number; down: number; up: number};

function statusPill(status: LiveStatus, connected: boolean) {
  if (status === 'live') return <span className="pill pill--good">실시간</span>;
  if (status === 'stale') return <span className="pill pill--warn">신호 지연</span>;
  if (status === 'disconnected' || !connected) return <span className="pill pill--warn">에이전트 연결 끊김</span>;
  return <span className="pill">데이터를 기다리는 중</span>;
}

function Sparkline({points, label}: {points: Point[]; label: string}) {
  const end = points.at(-1)?.at ?? Date.now();
  const start = end - liveWindowMs;
  const max = Math.max(1, ...points.map(p => Math.max(p.down, p.up)));
  const line = (key: 'down' | 'up') => points.map(p =>
    `${(((p.at - start) / liveWindowMs) * 300).toFixed(1)},${(62 - (p[key] / max) * 58).toFixed(1)}`).join(' ');
  return <svg className="live-spark" viewBox="0 0 300 64" preserveAspectRatio="none" role="img" aria-label={label}>
    <line x1="0" x2="300" y1="62" y2="62" stroke="var(--line)" strokeWidth="1" />
    {points.length > 1 && <>
      <polyline points={line('down')} fill="none" stroke="var(--blue)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polyline points={line('up')} fill="none" stroke="var(--orange)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </>}
  </svg>;
}

function Rate({icon, label, value, tone}: {icon: 'down' | 'up'; label: string; value: string; tone: 'download' | 'upload'}) {
  return <div className={`live-rate live-rate--${tone}`}>
    <span className="live-rate-label">{icon === 'down' ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUp size={14} aria-hidden="true" />}{label}</span>
    <strong className="number">{value}</strong>
  </div>;
}

export function LiveTrafficCard({clientLabels, connected}: {clientLabels: Record<string, string>; connected: boolean}) {
  const live = useLive();
  const latest = live.status === 'live' ? live.frames.at(-1) : undefined;
  const points = live.frames.map(f => ({at: f.at, down: f.totals.internet.down, up: f.totals.internet.up}));
  const show = (bytes: number | undefined) => latest && bytes !== undefined ? bitRate(bytes) : '—';
  return <section className="panel">
    <div className="section-header"><div><p className="eyebrow">LIVE</p><h2 className="panel-title mt-1">지금 사용 중인 트래픽</h2>
      <p className="panel-subtitle">게이트웨이 에이전트가 1초마다 보내는 값입니다.</p></div>{statusPill(live.status, connected)}</div>
    <div className="live-grid">
      <div className="space-y-3">
        <p className="live-caption"><Gauge size={14} aria-hidden="true" /> 인터넷</p>
        <div className="chart-stat-grid">
          <Rate icon="down" label="다운로드" value={show(latest?.totals.internet.down)} tone="download" />
          <Rate icon="up" label="업로드" value={show(latest?.totals.internet.up)} tone="upload" />
        </div>
        <Sparkline points={points} label="최근 1분 인터넷 다운로드와 업로드 속도" />
        <p className="text-xs muted">LAN(게이트웨이 경유) ↓ {show(latest?.totals.lan.down)} · ↑ {show(latest?.totals.lan.up)}</p>
      </div>
      <div>
        <p className="live-caption mb-2">지금 인터넷을 많이 쓰는 클라이언트</p>
        {latest && latest.clients.length ? <ul>{latest.clients.slice(0, 5).map(([id, up, down], index) => <li key={id}>
          <Link href={`/clients/${id}`} className="top-client-row"><span className="flex min-w-0 items-center gap-2"><span className="rank">{index + 1}</span>
            <span className="truncate">{clientLabels[id] ?? '이름 없는 기기'}</span></span>
            <span className="number shrink-0 text-xs"><span style={{color: 'var(--blue)'}}>↓ {bitRate(down)}</span> <span style={{color: 'var(--orange)'}}>↑ {bitRate(up)}</span></span></Link>
        </li>)}</ul> : <p className="text-sm muted">{latest ? '지금 트래픽을 쓰는 클라이언트가 없습니다.' : '실시간 데이터가 들어오면 표시합니다.'}</p>}
        {latest && latest.omitted > 0 && <p className="mt-2 text-xs muted">사용량이 적은 {latest.omitted}대는 생략했습니다.</p>}
      </div>
    </div>
  </section>;
}

export function ClientLiveTraffic({clientId, connected}: {clientId: string; connected: boolean}) {
  const live = useLive();
  const rowAt = (i: number) => live.frames[i].clients.find(row => row[0] === clientId);
  const points = live.frames.map((f, i) => { const row = rowAt(i); return {at: f.at, down: row?.[2] ?? 0, up: row?.[1] ?? 0}; });
  const latest = live.status === 'live' && live.frames.length ? rowAt(live.frames.length - 1) ?? [clientId, 0, 0, 0, 0] : null;
  const show = (bytes: number | undefined) => latest && bytes !== undefined ? bitRate(bytes) : '—';
  return <section className="panel">
    <div className="section-header"><div><p className="eyebrow">LIVE</p><h2 className="panel-title mt-1">실시간 속도</h2>
      <p className="panel-subtitle">게이트웨이를 지나는 이 기기의 트래픽입니다.</p></div>{statusPill(live.status, connected)}</div>
    <div className="chart-stat-grid">
      <Rate icon="down" label="인터넷 다운로드" value={show(latest?.[2])} tone="download" />
      <Rate icon="up" label="인터넷 업로드" value={show(latest?.[1])} tone="upload" />
    </div>
    <div className="mt-3"><Sparkline points={points} label="최근 1분 이 기기의 인터넷 속도" /></div>
    <p className="mt-2 text-xs muted">LAN(게이트웨이 경유) ↓ {show(latest?.[4])} · ↑ {show(latest?.[3])}</p>
  </section>;
}
