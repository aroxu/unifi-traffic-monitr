import { eq } from 'drizzle-orm';
import { getDb, settings } from '@utm/db';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authorized, privateResponse } from '@/lib/api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const patchSchema = z.object({
  timezone: z.literal('Asia/Seoul').optional(),
  rawRetentionDays: z.number().int().min(1).max(90).optional(),
  fiveMinuteRetentionDays: z.number().int().min(1).max(365).optional(),
  hourlyRetentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();
export async function GET() {
  const rejected = await authorized(); if (rejected) return rejected;
  const rows = await getDb().select().from(settings).where(eq(settings.id, 1));
  return NextResponse.json(rows[0] ?? {timezone: 'Asia/Seoul', rawRetentionDays: 7, fiveMinuteRetentionDays: 90, hourlyRetentionDays: 365}, privateResponse);
}
export async function PATCH(request: NextRequest) {
  const rejected = await authorized(); if (rejected) return rejected;
  const body = patchSchema.safeParse(await request.json().catch(() => null));
  if (!body.success || !Object.keys(body.data).length) return NextResponse.json({error: 'invalid_body'}, {status: 400, ...privateResponse});
  const current = (await getDb().select().from(settings).where(eq(settings.id, 1)))[0];
  const raw = body.data.rawRetentionDays ?? current?.rawRetentionDays ?? 7;
  const five = body.data.fiveMinuteRetentionDays ?? current?.fiveMinuteRetentionDays ?? 90;
  const hourly = body.data.hourlyRetentionDays ?? current?.hourlyRetentionDays ?? 365;
  if (raw > five || five > hourly) return NextResponse.json({error: 'invalid_retention_order'}, {status: 400, ...privateResponse});
  const rows = await getDb().insert(settings).values({id: 1, ...body.data}).onConflictDoUpdate({target: settings.id, set: {...body.data, updatedAt: new Date()}}).returning();
  return NextResponse.json(rows[0], privateResponse);
}
