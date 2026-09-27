import { LoginForm } from '@/components/login-form';
export default function LoginPage() {
  return <main className="mx-auto flex min-h-screen max-w-md items-center px-4"><div className="panel w-full space-y-5">
    <div><h1 className="text-2xl font-semibold">관리자 로그인</h1><p className="mt-2 text-sm muted">UniFi Traffic Monitor에 접속합니다.</p></div>
    <LoginForm />
  </div></main>;
}
