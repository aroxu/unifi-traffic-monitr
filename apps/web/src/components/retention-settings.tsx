'use client';

import {useState, type FormEvent} from 'react';
import {Button} from '@heroui/react';

type Retention = {rawRetentionDays: number; fiveMinuteRetentionDays: number; hourlyRetentionDays: number};
const fields = [
  {key: 'rawRetentionDays', label: '원본·상세 구간', max: 90},
  {key: 'fiveMinuteRetentionDays', label: '5분 집계', max: 365},
  {key: 'hourlyRetentionDays', label: '시간 집계', max: 3650}
] as const;

export function RetentionSettings({initial}: {initial: Retention}) {
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{error: boolean; text: string} | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!Number.isInteger(values.rawRetentionDays) || !Number.isInteger(values.fiveMinuteRetentionDays) ||
        !Number.isInteger(values.hourlyRetentionDays) || values.rawRetentionDays < 1 || values.rawRetentionDays > 90 ||
        values.fiveMinuteRetentionDays < values.rawRetentionDays || values.fiveMinuteRetentionDays > 365 ||
        values.hourlyRetentionDays < values.fiveMinuteRetentionDays || values.hourlyRetentionDays > 3650) {
      setMessage({error: true, text: '원본 ≤ 5분 집계 ≤ 시간 집계 순서와 허용 범위를 확인하세요.'});
      return;
    }
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {method: 'PATCH', credentials: 'same-origin',
        headers: {'content-type': 'application/json'}, body: JSON.stringify(values)});
      if (!response.ok) throw new Error('save_failed');
      const saved = await response.json() as Retention;
      setValues({rawRetentionDays: saved.rawRetentionDays,
        fiveMinuteRetentionDays: saved.fiveMinuteRetentionDays, hourlyRetentionDays: saved.hourlyRetentionDays});
      setMessage({error: false, text: '보존 설정을 저장했습니다. 다음 정리 작업부터 적용됩니다.'});
    } catch {
      setMessage({error: true, text: '설정을 저장하지 못했습니다. 다시 시도하세요.'});
    } finally { setSaving(false); }
  }
  return <section className="panel"><p className="eyebrow">RETENTION</p><h2 className="panel-title mt-1">보존 설정</h2>
    <p className="mt-2 text-sm muted">표시 시간대 Asia/Seoul · 롤업으로 합계를 보존한 뒤 오래된 상세 기록을 정리합니다.</p>
    <form onSubmit={event => void save(event)} className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">{fields.map(field => <label key={field.key} className="input-label">
        {field.label} (일)
        <input type="number" required min={1} max={field.max} step={1} value={values[field.key]}
          onChange={event => {setValues(previous => ({...previous, [field.key]: Number(event.target.value)})); setMessage(null);}}
          className="input-field" />
      </label>)}</div>
      <p className="text-xs muted">원본·상세 구간 ≤ 5분 집계 ≤ 시간 집계 순서로 설정하세요.</p>
      {message && <p role={message.error ? 'alert' : 'status'} className="text-sm">{message.text}</p>}
      <Button type="submit" isDisabled={saving} className="primary-button min-h-11 px-6">{saving ? '저장 중…' : '설정 저장'}</Button>
    </form>
  </section>;
}
