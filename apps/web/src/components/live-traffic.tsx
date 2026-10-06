'use client';

import Link from 'next/link';
import {ArrowDown, ArrowUp, Globe, Network} from 'lucide-react';
import {bitRate, formatUsage} from '@/lib/format';
import {liveWindowMs, useLive, type LiveFrame, type LiveStatus} from '@/lib/live-store';

type Point = {at: number; down: number; up: number};
type Pair = {up: number; down: number};
export type TodayUsage = {asOf: string | null; internet: Pair; lan: Pair};
// Bytes per second for one frame: internet up, internet down, LAN up, LAN down.
type Rates = [number, number, number, number];

function statusPill(status: LiveStatus, connected: boolean) {
  if (status === 'live') return <span className="pill pill--good">실시간</span>;
  if (status === 'stale') return <span className="pill pill--warn">신호 지연</span>;
  if (status === 'disconnected' || !connected) return <span className="pill pill--warn">에이전트 연결 끊김</span>;
  return <span className="pill">데이터를 기다리는 중</span>;
}

function Sparkline({points, label}: {points: Point[]; label: string}) {
  const end = points.at(-1)?.at ?? Date.now();
  const start = end - liveWindowMs;
  const shown = points.filter(p => p.at >= start);
  const max = Math.max(1, ...shown.map(p => Math.max(p.down, p.up)));
  const line = (key: 'down' | 'up') => shown.map(p =>
    `${(((p.at - start) / liveWindowMs) * 300).toFixed(1)},${(62 - (p[key] / max) * 58).toFixed(1)}`).join(' ');
  return <svg className="live-spark" viewBox="0 0 300 64" preserveAspectRatio="none" role="img" aria-label={label}>
    <line x1="0" x2="300" y1="62" y2="62" stroke="var(--line)" strokeWidth="1" />
    {shown.length > 1 && <>
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

const seoulOffsetMs = 9 * 3600000;
/** Start of the current day in Korea, which has no daylight saving time. */
const startOfToday = (now: number) => Math.floor((now + seoulOffsetMs) / 86400000) * 86400000 - seoulOffsetMs;

/** Stored usage plus the live bytes that arrived after it was saved, counting only today's frames. */
function todayWithLive(base: TodayUsage | null, frames: LiveFrame[], pick: (f: LiveFrame) => Rates): TodayUsage | null {
  if (!base) return null;
  const after = Math.max(base.asOf ? Date.parse(base.asOf) : 0, startOfToday(Date.now()) - 1);
  const add: Rates = [0, 0, 0, 0];
  for (const frame of frames) {
    if (frame.at <= after) continue;
    const rates = pick(frame);
    for (let i = 0; i < 4; i++) add[i] += rates[i] * frame.intervalMs / 1000;
  }
  return {asOf: base.asOf, internet: {up: base.internet.up + add[0], down: base.internet.down + add[1]},
    lan: {up: base.lan.up + add[2], down: base.lan.down + add[3]}};
}

const usage = (bytes: number) => formatUsage(Math.max(0, Math.round(bytes)).toString());

function ScopeBlock({kind, title, rates, points, today, label}: {kind: 'internet' | 'lan'; title: string;
  rates: Pair | null; points: Point[]; today: Pair | null; label: string}) {
  const show = (value: number | undefined) => rates && value !== undefined ? bitRate(value) : '—';
  return <div className="live-scope">
    <p className="live-caption">{kind === 'internet' ? <Globe size={14} aria-hidden="true" /> : <Network size={14} aria-hidden="true" />}{title}</p>
    <div className="chart-stat-grid">
      <Rate icon="down" label="다운로드" value={show(rates?.down)} tone="download" />
      <Rate icon="up" label="업로드" value={show(rates?.up)} tone="upload" />
    </div>
    <Sparkline points={points} label={label} />
    {today && <p className="live-today"><span>오늘 사용량</span>
      <span className="number"><span style={{color: 'var(--blue)'}}>↓ {usage(today.down)}</span> · <span style={{color: 'var(--orange)'}}>↑ {usage(today.up)}</span></span></p>}
  </div>;
}

const totalsOf = (f: LiveFrame): Rates => [f.totals.internet.up, f.totals.internet.down, f.totals.lan.up, f.totals.lan.down];

export function LiveTrafficCard({clientLabels, connected, today}: {clientLabels: Record<string, string>; connected: boolean;
  today: TodayUsage | null}) {
  const live = useLive();
  const latest = live.status === 'live' ? live.frames.at(-1) : undefined;
  const points = (scope: 'internet' | 'lan') => live.frames.map(f => ({at: f.at, down: f.totals[scope].down, up: f.totals[scope].up}));
  const current = todayWithLive(today, live.frames, totalsOf);
  return <section className="panel">
    <div className="section-header"><div><p className="eyebrow">LIVE</p><h2 className="panel-title mt-1">지금 사용 중인 트래픽</h2>
      <p className="panel-subtitle">게이트웨이 에이전트가 1초마다 보내는 값입니다. 오늘 사용량은 한국 시간 자정부터 누적합니다.</p></div>
      {statusPill(live.status, connected)}</div>
    <div className="live-grid">
      <div className="live-scopes">
        <ScopeBlock kind="internet" title="인터넷" rates={latest?.totals.internet ?? null} points={points('internet')}
          today={current?.internet ?? null} label="최근 1분 인터넷 다운로드와 업로드 속도" />
        <ScopeBlock kind="lan" title="내부 네트워크(게이트웨이 경유)" rates={latest?.totals.lan ?? null} points={points('lan')}
          today={current?.lan ?? null} label="최근 1분 내부 네트워크 다운로드와 업로드 속도" />
      </div>
      <div>
        <p className="live-caption mb-2">지금 트래픽을 많이 쓰는 클라이언트</p>
        {latest && latest.clients.length ? <ul>{latest.clients.slice(0, 6).map(([id, iUp, iDown, lUp, lDown], index) => <li key={id}>
          <Link href={`/clients/${id}`} className="live-client-row"><span className="rank">{index + 1}</span>
            <span className="min-w-0"><span className="block truncate font-semibold">{clientLabels[id] ?? '이름 없는 기기'}</span>
              <span className="live-client-rates number">인터넷 <span style={{color: 'var(--blue)'}}>↓ {bitRate(iDown)}</span> <span style={{color: 'var(--orange)'}}>↑ {bitRate(iUp)}</span>
                {(lUp > 0 || lDown > 0) && <> · 내부 <span style={{color: 'var(--blue)'}}>↓ {bitRate(lDown)}</span> <span style={{color: 'var(--orange)'}}>↑ {bitRate(lUp)}</span></>}</span></span></Link>
        </li>)}</ul> : <p className="text-sm muted">{latest ? '지금 트래픽을 쓰는 클라이언트가 없습니다.' : '실시간 데이터가 들어오면 표시합니다.'}</p>}
        {latest && latest.omitted > 0 && <p className="mt-2 text-xs muted">사용량이 적은 {latest.omitted}대는 생략했습니다.</p>}
      </div>
    </div>
    <p className="mt-4 text-xs muted">내부 네트워크는 게이트웨이와 주고받거나 다른 내부 네트워크로 오간 통신입니다. 같은 네트워크 안에서 스위치로만 오간 통신은 게이트웨이를 지나지 않아 포함되지 않습니다.</p>
  </section>;
}

export function ClientLiveTraffic({clientId, connected, today}: {clientId: string; connected: boolean; today: TodayUsage | null}) {
  const live = useLive();
  const rows = live.frames.map(f => f.clients.find(row => row[0] === clientId));
  const pick = (f: LiveFrame): Rates => {
    const row = f.clients.find(item => item[0] === clientId);
    return row ? [row[1], row[2], row[3], row[4]] : [0, 0, 0, 0];
  };
  const latest = live.status === 'live' && live.frames.length ? rows.at(-1) ?? [clientId, 0, 0, 0, 0] : null;
  const points = (scope: 'internet' | 'lan') => live.frames.map((f, i) => {
    const row = rows[i];
    return scope === 'internet' ? {at: f.at, up: row?.[1] ?? 0, down: row?.[2] ?? 0} : {at: f.at, up: row?.[3] ?? 0, down: row?.[4] ?? 0};
  });
  const current = todayWithLive(today, live.frames, pick);
  return <section className="panel">
    <div className="section-header"><div><p className="eyebrow">LIVE</p><h2 className="panel-title mt-1">실시간 속도 · 사용량</h2>
      <p className="panel-subtitle">게이트웨이를 지나는 이 기기의 트래픽입니다. 오늘 사용량은 한국 시간 자정부터 누적합니다.</p></div>
      {statusPill(live.status, connected)}</div>
    <div className="live-scopes live-scopes--split">
      <ScopeBlock kind="internet" title="인터넷" rates={latest ? {up: latest[1], down: latest[2]} : null} points={points('internet')}
        today={current?.internet ?? null} label="최근 1분 이 기기의 인터넷 속도" />
      <ScopeBlock kind="lan" title="내부 네트워크(게이트웨이 경유)" rates={latest ? {up: latest[3], down: latest[4]} : null} points={points('lan')}
        today={current?.lan ?? null} label="최근 1분 이 기기의 내부 네트워크 속도" />
    </div>
    <p className="mt-4 text-xs muted">내부 네트워크는 게이트웨이와 주고받거나 다른 내부 네트워크로 오간 통신입니다. 같은 네트워크 안에서 스위치로만 오간 통신은 포함되지 않습니다.</p>
  </section>;
}
