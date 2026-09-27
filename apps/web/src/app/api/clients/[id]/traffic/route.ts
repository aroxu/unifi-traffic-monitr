import {isUuid} from '@utm/contracts';
import {NextRequest, NextResponse} from 'next/server';
import {authorized, privateResponse} from '@/lib/api';
import {getClient} from '@/lib/queries';
import {getAvailableClientScopes, getClientTraffic, type MeasuredScope} from '@/lib/traffic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, {params}: {params: Promise<{id: string}>}) {
  const rejected = await authorized(); if (rejected) return rejected;
  const {id} = await params;
  if (!isUuid(id)) return NextResponse.json({error: 'invalid_id'}, {status: 400, ...privateResponse});
  if (!await getClient(id)) return NextResponse.json({error: 'not_found'}, {status: 404, ...privateResponse});
  const start = new Date(request.nextUrl.searchParams.get('start') ?? Date.now() - 86400000);
  const end = new Date(request.nextUrl.searchParams.get('end') ?? Date.now());
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || end.getTime() - start.getTime() > 31 * 86400000) {
    return NextResponse.json({error: 'invalid_query'}, {status: 400, ...privateResponse});
  }
  const scopes = await getAvailableClientScopes(id);
  const requested = request.nextUrl.searchParams.get('scope');
  if (requested && !scopes.includes(requested as MeasuredScope)) {
    return NextResponse.json({error: 'unsupported_scope'}, {status: 400, ...privateResponse});
  }
  const scope = requested as MeasuredScope | null ?? scopes[0];
  if (!scope) return NextResponse.json({status: 'unverified', availableScopes: [], start, end,
    uploadBytes: null, downloadBytes: null, points: []}, privateResponse);
  return NextResponse.json({status: 'measured', availableScopes: scopes,
    ...await getClientTraffic(id, scope, start, end)}, privateResponse);
}
