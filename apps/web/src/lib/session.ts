import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from './auth';

/** The signed-in session, looked up once per request. */
export const getSession = cache(async () => auth.api.getSession({headers: await headers()}));

/**
 * Send visitors without a session to the login page. Every dashboard page
 * calls this itself: on client navigation Next.js renders only the page that
 * changed, so a check in the shared layout does not protect page data.
 */
export async function requireSession() {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}
