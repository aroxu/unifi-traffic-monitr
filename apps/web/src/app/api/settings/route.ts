import { eq } from 'drizzle-orm';
import { getDb, getPool, settings, settingsDefaults as defaults } from '@utm/db';
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
  return NextResponse.json(rows[0] ?? defaults, privateResponse);
}
export async function PATCH(request: NextRequest) {
  const rejected = await authorized(); if (rejected) return rejected;
  const body = patchSchema.safeParse(await request.json().catch(() => null));
  if (!body.success || !Object.keys(body.data).length) return NextResponse.json({error: 'invalid_body'}, {status: 400, ...privateResponse});
  const {timezone, rawRetentionDays, fiveMinuteRetentionDays, hourlyRetentionDays} = body.data;
  try {
    // Merge the change into the stored row in one statement, so two saves at
    // once cannot combine into an invalid order. The table's check constraint
    // enforces raw <= five-minute <= hourly.
    const result = await getPool().query<typeof defaults & {updatedAt: Date}>(`INSERT INTO settings
        (id, timezone, raw_retention_days, five_minute_retention_days, hourly_retention_days, updated_at)
      VALUES (1, COALESCE($1, $5), COALESCE($2, $6::int), COALESCE($3, $7::int), COALESCE($4, $8::int), now())
      ON CONFLICT (id) DO UPDATE SET timezone=COALESCE($1, settings.timezone),
        raw_retention_days=COALESCE($2, settings.raw_retention_days),
        five_minute_retention_days=COALESCE($3, settings.five_minute_retention_days),
        hourly_retention_days=COALESCE($4, settings.hourly_retention_days), updated_at=now()
      RETURNING id, timezone, raw_retention_days AS "rawRetentionDays",
        five_minute_retention_days AS "fiveMinuteRetentionDays", hourly_retention_days AS "hourlyRetentionDays",
        updated_at AS "updatedAt"`,
      [timezone ?? null, rawRetentionDays ?? null, fiveMinuteRetentionDays ?? null, hourlyRetentionDays ?? null,
        defaults.timezone, defaults.rawRetentionDays, defaults.fiveMinuteRetentionDays, defaults.hourlyRetentionDays]);
    return NextResponse.json(result.rows[0], privateResponse);
  } catch (error) {
    if ((error as {code?: string}).code === '23514') {
      return NextResponse.json({error: 'invalid_retention_order'}, {status: 400, ...privateResponse});
    }
    throw error;
  }
}
