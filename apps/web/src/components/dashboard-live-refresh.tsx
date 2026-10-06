'use client';

import {useEffect, useRef, useState} from 'react';
import {usePathname, useRouter} from 'next/navigation';
import {checkLiveStale, pushLive} from '@/lib/live-store';

export function DashboardLiveRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const [connected, setConnected] = useState(false);
  pathnameRef.current = pathname;

  useEffect(() => {
    let source: EventSource | null = null;
    let ready = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      if (pathnameRef.current === '/') { window.dispatchEvent(new Event('utm:collection')); return; }
      // Without the event stream the server may be restarting. A failed
      // refresh makes Next.js fall back to a full page load, which leaves the
      // browser on its own connection error page.
      if (!ready) {
        try {
          if (!(await fetch('/login', {method: 'HEAD', cache: 'no-store'})).ok) return;
        } catch { return; }
      }
      router.refresh();
    };
    const open = () => {
      // A stream the browser gave up on (an error response such as 401 or
      // 503 is not retried) is replaced; a live or reconnecting one is kept.
      if (document.visibilityState !== 'visible' || (source && source.readyState !== EventSource.CLOSED)) return;
      source?.close();
      source = new EventSource('/api/overview/events');
      source.addEventListener('ready', () => { ready = true; setConnected(true); void refresh(); });
      source.addEventListener('refresh', () => void refresh());
      source.addEventListener('live', event => pushLive((event as MessageEvent<string>).data));
      source.onerror = () => { ready = false; setConnected(false); };
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') { void refresh(); open(); }
      else { source?.close(); source = null; ready = false; setConnected(false); }
    };
    document.addEventListener('visibilitychange', visibility);
    open();
    const fallback = setInterval(() => { if (!ready) { void refresh(); open(); } }, 15000);
    const staleCheck = setInterval(() => checkLiveStale(), 1000);
    return () => {
      clearInterval(fallback);
      clearInterval(staleCheck);
      document.removeEventListener('visibilitychange', visibility);
      source?.close();
    };
  }, [router]);

  return <span className={`pill ${connected ? 'pill--good' : ''}`} role="status">
    {connected ? '수집 후 자동 갱신' : '주기적으로 확인 중'}
  </span>;
}
