import { NextResponse } from 'next/server';
import { authorized, privateResponse } from '@/lib/api';
import { getDevices } from '@/lib/queries';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {const rejected = await authorized(); if (rejected) return rejected; return NextResponse.json(await getDevices(), privateResponse);}
