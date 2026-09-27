import { getDb, settings, trafficRollups } from '@utm/db';
import { eq, gt } from 'drizzle-orm';
import { getLatestRuns } from '@/lib/queries';
import { dateTime, runStatus } from '@/lib/format';
import {RetentionSettings} from '@/components/retention-settings';
export const dynamic = 'force-dynamic';
export default async function SettingsPage() {
  const [runs, values, scopes] = await Promise.all([getLatestRuns(), getDb().select().from(settings).where(eq(settings.id, 1)),
    getDb().selectDistinct({scope: trafficRollups.scope}).from(trafficRollups)
      .where(gt(trafficRollups.observedSeconds, 0))]);
  const current = values[0] ?? {timezone: 'Asia/Seoul', rawRetentionDays: 7, fiveMinuteRetentionDays: 90, hourlyRetentionDays: 365};
  const labels: Record<string, string> = {internet: '인터넷', combined: '전체 연결', lan: 'LAN', reported: '컨트롤러 제공(범위 미확인)'};
  return <div className="space-y-6"><div><h1 className="text-3xl font-semibold">상태 · 설정</h1><p className="mt-2 muted">수집 이력과 보존 설정</p></div>
    <section className="panel"><h2 className="font-semibold">사용량 확인 상태</h2><p className="mt-3 text-sm muted">클라이언트의 트래픽 정보를 수집합니다. {scopes.length ? `사용량 기록이 있는 범위: ${scopes.map(item => labels[item.scope] ?? item.scope).join(', ')}. 확인 시각은 장비 정보가 갱신되는 주기 때문에 추정입니다.` : '사용량 기록이 쌓이면 여기에서 범위를 표시합니다.'}</p></section>
    <RetentionSettings initial={{rawRetentionDays: current.rawRetentionDays,
      fiveMinuteRetentionDays: current.fiveMinuteRetentionDays, hourlyRetentionDays: current.hourlyRetentionDays}} />
    <section className="panel"><h2 className="font-semibold">최근 수집</h2>{runs.length ? <ul className="mt-3 space-y-2 text-sm">{runs.map(run => <li key={run.id} className="flex flex-wrap justify-between gap-2"><span>{runStatus(run.status)}{run.errorCode ? ` · ${run.errorCode}` : ''}</span><time>{dateTime(run.finishedAt ?? run.startedAt)}</time></li>)}</ul> : <p className="mt-3 text-sm muted">수집 기록이 없습니다.</p>}</section>
  </div>;
}
