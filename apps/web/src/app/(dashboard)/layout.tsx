import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { LogoutButton } from '@/components/logout-button';

const links = [['/', '개요'], ['/clients', '클라이언트'], ['/devices', '장비'], ['/settings', '상태 · 설정']];
export default async function DashboardLayout({children}: {children: React.ReactNode}) {
  const session = await requireSession();
  return <div className="mx-auto min-h-screen max-w-7xl px-4 pb-16 sm:px-6">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-black/10 py-5 dark:border-white/10">
      <div><div className="text-lg font-semibold">UniFi Traffic Monitor</div><div className="text-xs muted">네트워크 사용 현황</div></div>
      <div className="flex items-center gap-3 text-sm"><span className="hidden sm:inline muted">{session.user.email}</span><LogoutButton /></div>
    </header>
    <nav aria-label="주 메뉴" className="flex gap-1 overflow-x-auto py-4">{links.map(([href, label]) =>
      <Link key={href} href={href} className="min-h-11 shrink-0 rounded-xl px-4 py-3 text-sm font-medium hover:bg-black/5 focus-visible:outline-2 dark:hover:bg-white/10">{label}</Link>)}</nav>
    <main>{children}</main>
  </div>;
}
