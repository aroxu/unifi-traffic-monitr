'use client';

import {useEffect, useRef, useState} from 'react';
import {usePathname, useRouter} from 'next/navigation';

export function DashboardLiveRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const [connected, setConnected] = useState(false);
  pathnameRef.current = pathname;

  useEffect(() => {
    let source: EventSource | null = null;
    let ready = false;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (pathnameRef.current === '/') window.dispatchEvent(new Event('utm:collection'));
      else router.refresh();
    };
    const open = () => {
      if (source || document.visibilityState !== 'visible') return;
      source = new EventSource('/api/overview/events');
      source.addEventListener('ready', () => { ready = true; setConnected(true); refresh(); });
      source.addEventListener('refresh', refresh);
      source.onerror = () => { ready = false; setConnected(false); };
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') { refresh(); open(); }
      else { source?.close(); source = null; ready = false; setConnected(false); }
    };
    document.addEventListener('visibilitychange', visibility);
    open();
    const fallback = setInterval(() => { if (!ready) refresh(); }, 15000);
    return () => {
      clearInterval(fallback);
      document.removeEventListener('visibilitychange', visibility);
      source?.close();
    };
  }, [router]);

  return <span className={`pill ${connected ? 'pill--good' : ''}`} role="status">
    {connected ? '수집 후 자동 갱신' : '주기적으로 확인 중'}
  </span>;
}
