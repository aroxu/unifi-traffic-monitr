'use client';
import { useState, type FormEvent } from 'react';
import { Button } from '@heroui/react';
import { authClient } from '@/lib/auth-client';

export function LoginForm() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await authClient.signIn.email({email: String(data.get('email')), password: String(data.get('password'))});
      if (result.error) {setError('로그인 정보를 확인해 주세요.'); return;}
      window.location.assign('/');
    } catch {setError('로그인 요청에 실패했습니다.');}
    finally {setPending(false);}
  }
  return <form onSubmit={submit} className="space-y-4">
    <label className="input-label">이메일<input name="email" type="email" required autoComplete="username" className="input-field" /></label>
    <label className="input-label">비밀번호<input name="password" type="password" required autoComplete="current-password" className="input-field" /></label>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <Button type="submit" isDisabled={pending} className="primary-button min-h-11 w-full">{pending ? '확인 중…' : '로그인'}</Button>
  </form>;
}
