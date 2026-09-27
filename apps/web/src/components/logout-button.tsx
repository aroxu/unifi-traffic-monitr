'use client';
import { Button } from '@heroui/react';
import { authClient } from '@/lib/auth-client';

export function LogoutButton() {
  return <Button variant="tertiary" onPress={async () => {await authClient.signOut(); window.location.assign('/login');}}>로그아웃</Button>;
}
