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
export function dateTime(date: Date | string | null | undefined): string {
  return date ? new Intl.DateTimeFormat('ko-KR', {dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Seoul'}).format(new Date(date)) : '—';
}
export function runStatus(status: string | null | undefined): string {
  if (!status) return '시작 전';
  return status === 'measured' ? '사용량 수집 중' : status === 'raw_only' ? '트래픽 정보 수집 중' : status === 'identity_only' ? '연결 정보 수집 중' : status === 'error' ? '수집 오류' : status;
}
/** Format bytes per second as a network bit rate. */
export function bitRate(bytesPerSecond: number): string {
  const bits = Math.max(0, bytesPerSecond) * 8;
  if (bits < 1000) return `${Math.round(bits)} bps`;
  const [unit, divisor] = bits >= 1e9 ? ['Gbps', 1e9] : bits >= 1e6 ? ['Mbps', 1e6] : ['Kbps', 1e3];
  const value = bits / divisor;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
export const scopeLabels: Record<string, string> = {
  internet: '인터넷(게이트웨이 측정)', lan: 'LAN(게이트웨이 경유)', combined: '전체 연결', reported: '컨트롤러 보고'
};
