import Link from 'next/link';
import { getDeviceClientCounts, getDevices } from '@/lib/queries';
import { dateTime } from '@/lib/format';
export const dynamic = 'force-dynamic';
export default async function DevicesPage() {
  const [rows, counts] = await Promise.all([getDevices(), getDeviceClientCounts()]);
  const byDevice = new Map(counts.map(item => [item.deviceId, item.count]));
  return <div className="space-y-6"><div><h1 className="text-3xl font-semibold">장비</h1><p className="mt-2 muted">컨트롤러에서 확인된 장비</p></div>
    {rows.length ? <div className="grid gap-4 sm:grid-cols-2">{rows.map(device => <section className="panel" key={device.id}><h2 className="font-semibold">{device.name ?? device.model ?? '이름 미확인'}</h2><p className="mt-2 text-sm muted">{device.model ?? '모델 미확인'} · {device.online === null ? '상태 미확인' : device.online ? '온라인' : '오프라인'}</p><p className="mt-3 text-xs muted">최근 연결 {dateTime(device.lastSeenAt)}</p><Link href={`/clients?deviceId=${device.id}`} className="mt-3 inline-block min-h-11 rounded-xl px-4 py-3 text-sm underline">연결 클라이언트 {byDevice.get(device.id) ?? 0}대 보기</Link></section>)}</div> : <section className="panel muted">아직 등록된 장비가 없습니다.</section>}
  </div>;
}
