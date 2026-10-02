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
const errorHints: Record<string, string> = {
  tls_hostname_mismatch: '인증서 이름 불일치 · UNIFI_URL 확인',
  tls_untrusted_certificate: '신뢰할 수 없는 인증서 · CA 파일 확인',
  tls_certificate_expired: '인증서 만료',
  tls_certificate_not_yet_valid: '인증서 유효 기간 전 · 시계 확인',
  connection_refused: '연결 거부',
  connection_reset: '연결 끊김',
  dns_lookup_failed: '주소를 찾지 못함 · UNIFI_CONNECT_IP 확인',
  host_unreachable: '장비에 도달할 수 없음',
  timeout: '응답 시간 초과',
  http_401: 'API 키 확인',
  http_403: 'API 키 권한 확인',
  http_404: '주소 또는 사이트 확인',
  unifi_response_invalid: 'UniFi 응답 형식 오류 · collector 로그 확인',
  unifi_site_mismatch: 'UNIFI_SITE_UUID와 UNIFI_SITE 확인',
  db_write_failed: 'DB 저장 실패'
};
/** Short Korean explanation for a collector error code. */
export function errorHint(code: string | null | undefined): string | null {
  return code ? errorHints[code] ?? null : null;
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
