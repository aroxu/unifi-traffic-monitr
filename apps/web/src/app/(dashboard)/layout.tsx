import { requireSession } from '@/lib/session';
import { LogoutButton } from '@/components/logout-button';
import {DashboardNav} from '@/components/dashboard-nav';

export default async function DashboardLayout({children}: {children: React.ReactNode}) {
  const session = await requireSession();
  return <div className="app-shell">
    <DashboardNav />
    <div className="app-workspace">
      <header className="app-topbar">
        <div><div className="app-topbar-title">UniFi Traffic Monitor</div><div className="app-topbar-caption">네트워크 사용 현황</div></div>
        <div className="app-topbar-user"><span className="hidden sm:block">{session.user.email}</span><LogoutButton /></div>
      </header>
      <DashboardNav mobile />
      <main className="app-main">{children}</main>
    </div>
  </div>;
}
