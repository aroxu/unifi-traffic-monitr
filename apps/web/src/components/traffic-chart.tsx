'use client';

import {CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import type {TrafficPoint} from '@/lib/traffic';

export type TrafficData = {
  start: string; end: string; bucketSeconds: number;
  rateBasis: 'observed' | 'wall';
  boundaryEstimated: boolean;
  uploadBytes: string | null; downloadBytes: string | null; points: TrafficPoint[];
};

export function formatUsage(bytes: string | null): string {
  if (bytes === null) return '측정 없음';
  const value = BigInt(bytes);
  if (value === 0n) return '0 B';
  if (value < 1_000n) return `${value} B`;
  const unit = value >= 1_000_000_000n ? ['GB', 1_000_000_000n]
    : value >= 1_000_000n ? ['MB', 1_000_000n] : ['KB', 1_000n];
  const [label, divisor] = unit as [string, bigint];
  const whole = value / divisor;
  const fraction = (value % divisor) * 100n / divisor;
  return `${whole}.${fraction.toString().padStart(2, '0')} ${label}`;
}

export function TrafficChart({data}: {data: TrafficData}) {
  if (!data.points.some(point => point.uploadBytes !== null || point.downloadBytes !== null)) {
    return <p className="mt-4 text-sm muted">선택한 기간에 기록된 트래픽 구간이 없습니다.</p>;
  }
  const intervalMs = data.bucketSeconds * 1000;
  const measured = new Map(data.points.map(point => [new Date(point.bucketStart).getTime(), point]));
  const first = Math.floor(new Date(data.start).getTime() / intervalMs) * intervalMs;
  const end = new Date(data.end).getTime();
  const chart = [];
  for (let time = first; time < end; time += intervalMs) {
    const point = measured.get(time);
    chart.push({time,
      upload: point?.uploadBytes === null || point?.uploadBytes === undefined || !point.uploadObservedSeconds
        ? null : Number(point.uploadBytes) * 8 / (point.uploadObservedSeconds * 1_000_000),
      download: point?.downloadBytes === null || point?.downloadBytes === undefined || !point.downloadObservedSeconds
        ? null : Number(point.downloadBytes) * 8 / (point.downloadObservedSeconds * 1_000_000)});
  }
  const downloadDots = data.points.filter(point => point.downloadBytes !== null).length < 8;
  const uploadDots = data.points.filter(point => point.uploadBytes !== null).length < 8;
  const axisTime = (value: number) => new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric',
    ...(data.bucketSeconds <= 300 ? {hour: '2-digit' as const, minute: '2-digit' as const} : {})
  }).format(new Date(value));
  return <div className="mt-4 space-y-4">
    <div className="grid grid-cols-2 gap-3 text-sm"><p>다운로드 <strong className="number block text-lg">{formatUsage(data.downloadBytes)}</strong></p><p>업로드 <strong className="number block text-lg">{formatUsage(data.uploadBytes)}</strong></p></div>
    <p className="text-xs muted">{data.bucketSeconds / 60}분 단위 평균 속도(Mbps)입니다. {data.rateBasis === 'observed' ? '실제로 확인된 시간' : '전체 시간'}을 기준으로 계산합니다. 장비가 늦게 알려줄 수 있어 정확한 전송 시각은 추정입니다. 기록이 없는 시간은 확인하지 못했습니다.{data.boundaryEstimated && ' 기간 양끝은 해당 단위에 맞춰 계산한 추정치입니다.'}</p>
    <div className="h-72 min-w-0" role="img" aria-label="다운로드와 업로드의 시간별 평균 속도 그래프">
      <ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{top: 8, right: 14, bottom: 8, left: -10}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#94a3b866" />
        <XAxis dataKey="time" type="number" domain={[first, Math.ceil(end / intervalMs) * intervalMs]} tickFormatter={axisTime} tick={{fontSize: 11}} tickCount={5} />
        <YAxis unit=" Mbps" tick={{fontSize: 11}} width={70} />
        <Tooltip labelFormatter={label => axisTime(Number(label))} formatter={value => typeof value === 'number' ? `${value.toFixed(2)} Mbps` : '—'} />
        <Legend />
        <Line dataKey="download" name="다운로드" stroke="#2563eb" strokeWidth={2} dot={downloadDots ? {r: 4} : false} connectNulls={false} isAnimationActive={false} />
        <Line dataKey="upload" name="업로드" stroke="#d97706" strokeWidth={2} dot={uploadDots ? {r: 4} : false} connectNulls={false} isAnimationActive={false} />
      </LineChart></ResponsiveContainer>
    </div>
  </div>;
}
