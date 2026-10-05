import { NextResponse } from 'next/server';
import { getDesk, usingMemory } from '@/lib/desk';
import { config } from '@studiodesk/shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const desk = getDesk();
  const [studio, counts] = await Promise.all([
    desk.studio.getStudio(desk.ctx),
    desk.members.countByStatus(desk.ctx),
  ]);

  return NextResponse.json({
    status: 'ok',
    service: 'studiodesk-web',
    driver: desk.ctx.repo.kind,
    memory: usingMemory(),
    studio: { id: studio.id, name: studio.name, tier: studio.tier },
    members: counts,
    integrations: {
      supabase: config.hasHostedBackend(),
      groq: config.hasAi(),
      payments: config.hasPayments(),
      email: Boolean(config.resendApiKey() || config.useSendUrl()),
    },
    uptimeSeconds: Math.round(process.uptime()),
  });
}
