import { NextResponse } from 'next/server';
import { getDesk } from '@/lib/desk';
import { config } from '@studiodesk/shared';

/**
 * Payment webhooks.
 *
 * Signature verification is mandatory: an unverified webhook can mark a
 * membership paid without money moving. The raw body is read as text precisely
 * because HMAC must be computed over the exact bytes received.
 *
 * Configure the endpoint in your gateway dashboard:
 *   POST https://your-domain/api/billing/webhooks/polar
 *   POST https://your-domain/api/billing/webhooks/stripe
 */
export async function POST(
  request: Request,
  { params }: { params: { provider: string } },
) {
  const desk = getDesk();
  const provider = params.provider;
  const raw = await request.text();

  // Cheap rejection of junk before doing any crypto work.
  if (raw.length === 0 || raw.length > 512_000) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  if (request.headers.get('content-type')?.includes('application/json') !== true) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    switch (provider) {
      case 'stripe': {
        const signature = request.headers.get('stripe-signature');
        const secret = config.stripeWebhookSecret();
        if (!signature || !secret) {
          // No secret configured: refuse rather than trust an unsigned call.
          return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 });
        }
        const { verifyStripeSignature, handleStripeWebhook } = await import('@studiodesk/billing');
        const valid = await verifyStripeSignature(raw, signature, secret);
        if (!valid) return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });

        const { data } = (payload.data ?? {}) as { object?: Record<string, unknown> };
        const outcome = handleStripeWebhook({
          handled: true,
          type: String(payload.type ?? ''),
          paymentIntentId: data?.id as string | undefined,
          amountCents: typeof data?.amount === 'number' ? data.amount : undefined,
          failureCode: data?.failure_code as string | undefined,
          metadata: (data?.metadata ?? {}) as Record<string, string>,
        });
        await applyOutcome(desk, outcome);
        return NextResponse.json({ received: true });
      }

      case 'polar': {
        const secret = config.polarWebhookSecret();
        if (!secret) {
          return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 });
        }
        const signature =
          request.headers.get('polar-signature') ?? request.headers.get('x-polar-signature') ?? '';
        const { verifyHmac } = await import('@studiodesk/billing');
        const valid = signature
          ? await verifyHmac(raw, signature.startsWith('v1=') ? signature : `v1=${signature}`, secret, 300, 't')
          : false;
        if (!valid) return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });

        const { renewDueMemberships, dunningSummary } = await import('@studiodesk/billing');
        const type = String(payload.type ?? '');
        // Polar tells us a subscription lapsed; run the recovery path.
        if (type.includes('canceled') || type.includes('revoked')) {
          await dunningSummary(desk.ctx);
        }
        void renewDueMemberships;
        return NextResponse.json({ received: true, type });
      }

      default:
        return NextResponse.json({ error: 'unknown_provider' }, { status: 404 });
    }
  } catch (error) {
    // Log the real cause; return nothing revealing.
    console.error('[webhook] handler failed', provider, error);
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 });
  }
}

/** Applies a translated gateway event to the studio's data. */
async function applyOutcome(
  desk: ReturnType<typeof getDesk>,
  outcome: { emit?: string; memberId?: string; payload: Record<string, unknown> },
): Promise<void> {
  if (!outcome.emit || !outcome.memberId) return;

  if (outcome.emit === 'payment.succeeded') {
    const { memberships, markPaid } = await import('@studiodesk/billing');
    const membershipsRepo = desk.ctx.repo.table('memberships');
    const membership = await membershipsRepo.findOne({
      memberId: outcome.memberId,
      status: { $in: ['active', 'past_due', 'trialing'] },
    } as never);
    if (membership) {
      await markPaid(desk.ctx, (outcome.payload.invoiceId as string) ?? '', 0).catch(() => undefined);
      await membershipsRepo.update(membership.id, {
        status: 'active',
        dunningStage: 0,
        nextDunningAttemptAt: undefined,
        lastPaymentAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (outcome.emit === 'payment.failed') {
    const { registerFailedPayment } = await import('@studiodesk/billing');
    const membership = await desk.ctx.repo.table('memberships').findOne({
      memberId: outcome.memberId,
      status: { $in: ['active', 'past_due'] },
    } as never);
    if (membership) {
      await registerFailedPayment(desk.ctx, {
        membershipId: membership.id,
        amountCents: Number(outcome.payload.amountCents ?? 0),
        failureCode: outcome.payload.failureCode as string | undefined,
        gateway: 'stripe',
      });
    }
  }
}
