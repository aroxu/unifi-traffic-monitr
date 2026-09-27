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

  return <form className="panel grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={apply}>
    <label className="text-sm lg:col-span-2">이름, IP 또는 MAC<input name="q" value={search} onChange={event => setSearch(event.target.value)} placeholder="검색" className="mt-1 min-h-11 w-full rounded-xl border border-black/20 bg-transparent px-4 dark:border-white/20" /></label>
    <UiSelect label="연결 방식" value={connection} onValueChange={value => setConnection(value as ClientListQuery['connection'])}
      options={[{value: 'all', label: '전체'}, {value: 'wired', label: '유선'}, {value: 'wireless', label: '무선'}]} />
    <UiSelect label="연결 장비" value={deviceId} onValueChange={setDeviceId}
      options={[{value: 'all', label: '전체'}, ...devices.map(device => ({value: device.id, label: device.name ?? device.model ?? '이름 미확인'}))]} />
    <UiSelect label="정렬" value={sort} onValueChange={value => setSort(value as ClientListQuery['sort'])}
      options={[{value: 'recent', label: '최근 수집'}, {value: 'name', label: '이름순'}]} />
    <Button type="submit" className="min-h-11 sm:col-span-2 lg:col-span-5">적용</Button>
  </form>;
}
