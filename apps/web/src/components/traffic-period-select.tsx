'use client';

import {useRouter} from 'next/navigation';
import {UiSelect, type SelectOption} from '@/components/ui-select';

export const trafficPeriodOptions: SelectOption[] = [
  {value: '30m', label: '30분'}, {value: '1h', label: '1시간'}, {value: '3h', label: '3시간'},
  {value: '6h', label: '6시간'}, {value: '12h', label: '12시간'}, {value: '24h', label: '24시간'},
  {value: '7d', label: '7일'}, {value: '30d', label: '30일'}
];

export function TrafficPeriodSelect({clientId, period, scope}: {clientId: string; period: string; scope: string}) {
  const router = useRouter();
  return <div className="max-w-xs"><UiSelect label="트래픽 기간" value={period} options={trafficPeriodOptions}
    onValueChange={value => router.push(`/clients/${clientId}?period=${value}&scope=${scope}`)} /></div>;
}
