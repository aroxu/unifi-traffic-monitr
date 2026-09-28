'use client';

import {useState, type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import type {ClientListQuery} from '@utm/contracts';
import {Button} from '@heroui/react';
import {UiSelect} from '@/components/ui-select';

type DeviceOption = {id: string; name: string | null; model: string | null};

export function ClientFilters({query, devices}: {query: ClientListQuery; devices: DeviceOption[]}) {
  const router = useRouter();
  const [search, setSearch] = useState(query.q);
  const [connection, setConnection] = useState(query.connection);
  const [deviceId, setDeviceId] = useState(query.deviceId ?? 'all');
  const [sort, setSort] = useState(query.sort);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams({q: search.trim(), connection, sort, page: '1', limit: String(query.limit)});
    if (deviceId !== 'all') params.set('deviceId', deviceId);
    router.push(`/clients?${params}`);
  }

  return <form className="panel grid gap-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={apply}>
    <div className="sm:col-span-2 lg:col-span-4"><p className="eyebrow">FILTER</p><h2 className="panel-title mt-1">클라이언트 찾기</h2></div>
    <label className="input-label">이름, IP 또는 MAC<input name="q" value={search} onChange={event => setSearch(event.target.value)} placeholder="검색어 입력" className="input-field" /></label>
    <UiSelect label="연결 방식" value={connection} onValueChange={value => setConnection(value as ClientListQuery['connection'])}
      options={[{value: 'all', label: '전체'}, {value: 'wired', label: '유선'}, {value: 'wireless', label: '무선'}]} />
    <UiSelect label="연결 장비" value={deviceId} onValueChange={setDeviceId}
      options={[{value: 'all', label: '전체'}, ...devices.map(device => ({value: device.id, label: device.name ?? device.model ?? '이름 미확인'}))]} />
    <UiSelect label="정렬" value={sort} onValueChange={value => setSort(value as ClientListQuery['sort'])}
      options={[{value: 'recent', label: '최근 수집'}, {value: 'name', label: '이름순'}]} />
    <div className="sm:col-span-2 lg:col-span-4"><Button type="submit" className="primary-button min-h-11 px-6">필터 적용</Button></div>
  </form>;
}
