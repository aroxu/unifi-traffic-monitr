import { getDb, settings, trafficRollups } from '@utm/db';
import { eq, gt } from 'drizzle-orm';
import { getAgentStatus, getAgentUnattributed, getLatestRuns } from '@/lib/queries';
import { dateTime, formatUsage, runStatus, scopeLabels } from '@/lib/format';
import {RetentionSettings} from '@/components/retention-settings';
export const dynamic = 'force-dynamic';
export default async function SettingsPage() {
  const [runs, values, scopes, agent, unattributed] = await Promise.all([getLatestRuns(), getDb().select().from(settings).where(eq(settings.id, 1)),
    getDb().selectDistinct({scope: trafficRollups.scope}).from(trafficRollups)
      .where(gt(trafficRollups.observedSeconds, 0)), getAgentStatus(), getAgentUnattributed()]);
  const current = values[0] ?? {timezone: 'Asia/Seoul', rawRetentionDays: 7, fiveMinuteRetentionDays: 90, hourlyRetentionDays: 365};
  const labels: Record<string, string> = {...scopeLabels, reported: '컨트롤러 제공(범위 미확인)'};
  return <div className="space-y-6"><div className="page-heading"><div><p className="eyebrow mb-2">SYSTEM</p><h1>상태 · 설정</h1><p>수집 이력과 데이터 보존 기간을 관리합니다.</p></div></div>
    {agent && <section className="panel"><div className="section-header"><div><p className="eyebrow">GATEWAY AGENT</p><h2 className="panel-title mt-1">게이트웨이 에이전트</h2>
      <p className="panel-subtitle">UCG에 설치한 에이전트가 트래픽을 직접 셉니다. 연결이 끊긴 동안의 5분 기록은 다시 연결되면 채웁니다.</p></div>
      <span className={`pill ${agent.connected ? 'pill--good' : 'pill--warn'}`}>{agent.connected ? '연결됨' : '연결 끊김'}</span></div>
      <dl className="detail-list"><dt>버전</dt><dd>{agent.agentVersion ?? '—'}</dd>
        <dt>{agent.connected ? '연결 시각' : '끊긴 시각'}</dt><dd>{dateTime(agent.connected ? agent.connectedAt : agent.disconnectedAt)}</dd>
        <dt>마지막 실시간 수신</dt><dd>{dateTime(agent.lastFrameAt)}</dd>
        <dt>마지막 5분 기록</dt><dd>{dateTime(agent.lastFinalBucket)}</dd>
        <dt>에이전트 보관 시작</dt><dd>{dateTime(agent.earliestAvailable)}</dd>
        <dt>기기를 알 수 없는 트래픽(24시간)</dt><dd>↓ {formatUsage(unattributed.download)} · ↑ {formatUsage(unattributed.upload)}</dd>
        {!agent.connected && agent.lastError && <><dt>마지막 오류</dt><dd>{agent.lastError}</dd></>}</dl></section>}
    <section className="panel"><p className="eyebrow">COLLECTION</p><h2 className="panel-title mt-1">사용량 확인 상태</h2><p className="mt-3 text-sm muted">클라이언트의 트래픽 정보를 수집합니다. {scopes.length ? `사용량 기록이 있는 범위: ${scopes.map(item => labels[item.scope] ?? item.scope).join(', ')}. 확인 시각은 장비 정보가 갱신되는 주기 때문에 추정입니다.` : '사용량 기록이 쌓이면 여기에서 범위를 표시합니다.'}</p></section>
    <RetentionSettings initial={{rawRetentionDays: current.rawRetentionDays,
      fiveMinuteRetentionDays: current.fiveMinuteRetentionDays, hourlyRetentionDays: current.hourlyRetentionDays}} />
    <section className="panel"><p className="eyebrow">HISTORY</p><h2 className="panel-title mt-1">최근 수집</h2>{runs.length ? <ul className="mt-4 text-sm">{runs.map(run => <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-3" style={{borderColor: 'var(--line)'}}><span className={`pill ${run.status === 'error' ? 'pill--warn' : 'pill--good'}`}>{runStatus(run.status)}{run.errorCode ? ` · ${run.errorCode}` : ''}</span><time className="muted">{dateTime(run.finishedAt ?? run.startedAt)}</time></li>)}</ul> : <p className="mt-3 text-sm muted">수집 기록이 없습니다.</p>}</section>
  </div>;
}
