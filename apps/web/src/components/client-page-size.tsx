'use client';

import {usePathname, useRouter} from 'next/navigation';
import {UiSelect} from '@/components/ui-select';

export function ClientPageSize({value}: {value: number}) {
  const router = useRouter();
  const pathname = usePathname();
  const options = [10, 25, 50, 100].filter(limit => limit !== value).sort((a, b) => a - b);
  const allOptions = [{value: String(value), label: `${value}개`}, ...options.map(limit => ({value: String(limit), label: `${limit}개`}))];
  return <div className="w-36"><UiSelect label="페이지당 표시" value={String(value)} options={allOptions}
    onValueChange={next => {
      const params = new URLSearchParams(window.location.search);
      params.set('limit', next);
      params.set('page', '1');
      router.push(`${pathname}?${params}`);
    }} /></div>;
}
