import { NextResponse } from 'next/server';
import { getDesk } from '@/lib/desk';
import type { TableName } from '@studiodesk/core';

export const dynamic = 'force-dynamic';

/** Every table, in dependency order. */
const TABLES: TableName[] = [
  'studios',
  'plans',
  'instructors',
  'members',
  'classes',
  'bookings',
  'attendance',
  'memberships',
  'invoices',
  'charges',
  'packs',
  'dropIns',
  'fees',
  'notifications',
  'dunningEvents',
  'devices',
];

/** Full data export. StudioDesk stores everything you can see in the app. */
export async function GET() {
  const desk = getDesk();
  const out: Record<string, unknown[]> = {};

  for (const table of TABLES) {
    out[table] = await desk.ctx.repo.table(table).list({ limit: 100_000 });
  }

  const studio = await desk.studio.getStudio(desk.ctx);

  return new NextResponse(
    JSON.stringify({ studio, exportedAt: new Date().toISOString(), data: out }, null, 2),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="studiodesk-${studio.id}-export.json"`,
      },
    },
  );
}
