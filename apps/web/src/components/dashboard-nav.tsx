'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {Activity, LayoutDashboard, Network, Settings2, UsersRound} from 'lucide-react';

const links = [
  {href: '/', label: '개요', icon: LayoutDashboard},
  {href: '/clients', label: '클라이언트', icon: UsersRound},
  {href: '/devices', label: '장비', icon: Network},
  {href: '/settings', label: '상태 · 설정', icon: Settings2}
];

function NavLinks() {
  const pathname = usePathname();
  return links.map(({href, label, icon: Icon}) => {
    const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
    return <Link key={href} href={href} className="app-nav-link" aria-current={active ? 'page' : undefined}>
      <Icon size={18} strokeWidth={1.9} aria-hidden="true" />{label}
    </Link>;
  });
}

export function DashboardNav({mobile = false}: {mobile?: boolean}) {
  if (mobile) return <nav aria-label="모바일 주 메뉴" className="app-mobile-nav"><NavLinks /></nav>;
  return <aside className="app-sidebar">
    <Link href="/" className="app-brand" aria-label="UniFi Traffic Monitor 개요">
      <span className="app-brand-mark"><Activity size={22} strokeWidth={2.3} aria-hidden="true" /></span>
      <span><span className="app-brand-name block">UniFi Traffic</span><span className="app-brand-sub block">NETWORK MONITOR</span></span>
    </Link>
    <p className="app-nav-label">WORKSPACE</p>
    <nav aria-label="주 메뉴" className="app-nav"><NavLinks /></nav>
    <div className="sidebar-footer"><strong>Network overview</strong>수집된 네트워크 상태를 확인합니다.</div>
  </aside>;
}
