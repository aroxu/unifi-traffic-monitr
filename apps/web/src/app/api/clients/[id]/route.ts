import { NextResponse } from 'next/server';
import { isUuid } from '@utm/contracts';
import { authorized, privateResponse } from '@/lib/api';
import { getClient } from '@/lib/queries';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const rejected = await authorized(); if (rejected) return rejected;
  const {id} = await params;
  if (!isUuid(id)) return NextResponse.json({error: 'invalid_id'}, {status: 400, ...privateResponse});
  const client = await getClient(id);
  return client ? NextResponse.json(client, privateResponse) : NextResponse.json({error: 'not_found'}, {status: 404, ...privateResponse});
}
