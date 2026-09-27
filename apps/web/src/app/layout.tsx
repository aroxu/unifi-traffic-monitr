import type { Metadata } from 'next';
import {AppThemeProvider} from '@/components/app-theme-provider';
import './globals.css';

export const metadata: Metadata = {title: 'UniFi Traffic Monitor', description: 'UniFi 연결 및 트래픽 관측'};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="ko" suppressHydrationWarning><body><AppThemeProvider>{children}</AppThemeProvider></body></html>;
}
