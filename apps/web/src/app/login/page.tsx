import { LoginForm } from '@/components/login-form';
import {Activity} from 'lucide-react';
export default function LoginPage() {
  return <main className="login-shell"><div className="login-card">
    <div className="app-brand"><span className="app-brand-mark"><Activity size={22} strokeWidth={2.3} aria-hidden="true" /></span><span><span className="app-brand-name block">UniFi Traffic</span><span className="app-brand-sub block">NETWORK MONITOR</span></span></div>
    <p className="eyebrow mb-2">WELCOME BACK</p><h1 className="text-2xl font-bold tracking-tight">관리자 로그인</h1><p className="mt-2 mb-6 text-sm muted">네트워크 현황을 확인하려면 로그인하세요.</p>
    <LoginForm />
  </div></main>;
}
