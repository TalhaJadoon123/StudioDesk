import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';
import { getDesk } from '@/lib/desk';

/**
 * Server actions for the app shell, implemented as a POST endpoint so the
 * forms stay plain HTML (no client JS required, works with JS disabled).
 *
 * Every action is idempotent and revalidates the affected pages.
 */
export async function POST(request: Request) {
  const desk = getDesk();
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const memberId = String(form.get('memberId') ?? '');
  const redirect = String(form.get('redirect') ?? '/dashboard');

  try {
    switch (intent) {
      case 'pause': {
        await desk.members.pauseMember(desk.ctx, memberId, Number(form.get('days') ?? 30));
        revalidatePath('/dashboard');
        revalidatePath('/members');
        revalidatePath(`/members/${memberId}`);
        break;
      }
      case 'resume': {
        await desk.members.resumeMember(desk.ctx, memberId);
        revalidatePath('/dashboard');
        revalidatePath('/members');
        revalidatePath(`/members/${memberId}`);
        break;
      }
      case 'cancel': {
        await desk.members.cancelMember(desk.ctx, memberId, String(form.get('reason') ?? 'Cancelled by studio'));
        revalidatePath('/dashboard');
        revalidatePath('/members');
        revalidatePath(`/members/${memberId}`);
        break;
      }
      case 'kiosk-class': {
        // Kiosk taps carry an explicit class so the wrong person cannot be
        // checked into the wrong session.
        const { kioskCheckin } = await import('@studiodesk/checkin');
        await kioskCheckin(desk.ctx, {
          deviceId: String(form.get('deviceId') ?? ''),
          memberId,
          classId: (form.get('classId') as string) || undefined,
        });
        revalidatePath(`/kiosk/${String(form.get('deviceId') ?? '')}`);
        break;
      }
      case 'run-dunning': {
        const { runDunning, dunningSummary } = await import('@studiodesk/billing');
        const gateways = (await import('@studiodesk/billing')).createGateways();
        const result = await runDunning(desk.ctx, gateways.recurring);
        revalidatePath('/billing');
        return NextResponse.redirect(new URL(`/billing?ran=1&recovered=${result.recovered}`, request.url));
      }
      case 'create-member': {
        const member = await desk.members.createMember(desk.ctx, {
          name: String(form.get('name') ?? 'New member'),
          email: (form.get('email') as string) || undefined,
          phone: (form.get('phone') as string) || undefined,
          planId: (form.get('planId') as string) || 'plan_unlimited',
        });
        revalidatePath('/members');
        return NextResponse.redirect(new URL(`/members/${member.id}?created=1`, request.url));
      }
      default:
        return NextResponse.json({ error: 'unknown_intent' }, { status: 400 });
    }
  } catch (error) {
    // Expected failures (double booking, full class) get a readable message;
    // anything else is a bug, so only the status code is reported.
    const status = (error as { statusCode?: number })?.statusCode ?? 500;
    const message = error instanceof Error ? error.message : 'Action failed';
    const safe = status < 500 ? message : 'Something went wrong on our side.';
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(safe)}`, request.url), {
      status: status < 500 ? 303 : 303,
    });
  }

  return NextResponse.redirect(new URL(redirect, request.url));
}
