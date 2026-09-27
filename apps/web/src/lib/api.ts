import { NextResponse } from 'next/server';
import { getSession } from './session';

export const privateResponse = {headers: {'Cache-Control': 'private, no-store'}};
export async function authorized() {
  const session = await getSession();
  return session ? null : NextResponse.json({error: 'unauthorized'}, {status: 401, ...privateResponse});
}
