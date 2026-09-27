export function dateTime(date: Date | string | null | undefined): string {
  return date ? new Intl.DateTimeFormat('ko-KR', {dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Seoul'}).format(new Date(date)) : '—';
}
export function runStatus(status: string | null | undefined): string {
  if (!status) return '시작 전';
  return status === 'measured' ? '사용량 수집 중' : status === 'raw_only' ? '트래픽 정보 수집 중' : status === 'identity_only' ? '연결 정보 수집 중' : status === 'error' ? '수집 오류' : status;
}
