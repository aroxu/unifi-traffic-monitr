import Link from 'next/link';
import { getDeviceClientCounts, getDevices } from '@/lib/queries';
import { dateTime } from '@/lib/format';
import { requireSession } from '@/lib/session';
import {ArrowUpRight, Router} from 'lucide-react';
export const dynamic = 'force-dynamic';
export default async function DevicesPage() {
  await requireSession();
  const [rows, counts] = await Promise.all([getDevices(), getDeviceClientCounts()]);
  const byDevice = new Map(counts.map(item => [item.deviceId, item.count]));
  return <div className="space-y-6"><div className="page-heading"><div><p className="eyebrow mb-2">DEVICES</p><h1>장비</h1><p>컨트롤러에서 확인된 장비의 연결 상태입니다.</p></div><span className="pill pill--good">전체 {rows.length}대</span></div>
    {rows.length ? <div className="grid gap-4 sm:grid-cols-2">{rows.map(device => <section className="panel" key={device.id}><div className="flex items-start justify-between gap-3"><span className="metric-icon"><Router size={19} aria-hidden="true" /></span><span className={`pill ${device.online ? 'pill--good' : ''}`}>{device.online === null ? '상태 미확인' : device.online ? '온라인' : '오프라인'}</span></div><h2 className="panel-title mt-4">{device.name ?? device.model ?? '이름 미확인'}</h2><p className="panel-subtitle">{device.model ?? '모델 미확인'}</p><p className="mt-5 border-t pt-4 text-xs muted" style={{borderColor: 'var(--line)'}}>최근 연결 {dateTime(device.lastSeenAt)}</p><Link href={`/clients?deviceId=${device.id}`} className="text-link mt-2">연결 클라이언트 {byDevice.get(device.id) ?? 0}대 보기 <ArrowUpRight size={15} aria-hidden="true" /></Link></section>)}</div> : <section className="panel muted">아직 등록된 장비가 없습니다.</section>}
  </div>;
}
