import { NextRequest, NextResponse } from 'next/server';
import { clientListQuerySchema } from '@utm/contracts';
import { authorized, privateResponse } from '@/lib/api';
import { getClients } from '@/lib/queries';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const rejected = await authorized(); if (rejected) return rejected;
  const query = clientListQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({error: 'invalid_query'}, {status: 400, ...privateResponse});
  return NextResponse.json(await getClients(query.data), privateResponse);
}
