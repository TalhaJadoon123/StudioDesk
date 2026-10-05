import { newDropInId, sortBy, type DropIn } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { createBooking } from '@studiodesk/core';
import { createInvoice, markPaid } from './invoices.js';
import { chargeKey } from './stripe.js';
import type { PaymentGateway } from './gateway.js';

export function dropInsRepo(ctx: CoreContext) {
  return ctx.repo.table('dropIns');
}

export const DEFAULT_DROP_IN_PRICE_CENTS = 2_200;

export interface PurchaseDropInInput {
  memberId: string;
  classId: string;
  priceCents?: number;
  gateway?: PaymentGateway;
  idempotencyKey?: string;
  /** Book immediately after payment. Default true. */
  autoBook?: boolean;
}

export interface PurchaseDropInResult {
  dropIn: DropIn;
  invoiceId?: string;
  charged: boolean;
  paymentId?: string;
  bookingId?: string;
  /** Set when the class was full and the member landed on the waitlist. */
  waitlisted: boolean;
  amountCents: number;
  failureCode?: string;
}

/**
 * Sells a single-class drop-in and books it in one step.
 *
 * A drop-in bypasses credits entirely, so a member on an empty pack can still
 * walk in. It does not block a full class: if the class is full the member is
 * waitlisted and the drop-in stays valid.
 */
export async function purchaseDropIn(
  ctx: CoreContext,
  input: PurchaseDropInInput,
): Promise<PurchaseDropInResult> {
  const [member, klass] = await Promise.all([
    ctx.repo.table('members').findById(input.memberId),
    ctx.repo.table('classes').findById(input.classId),
  ]);
  if (!member) throw new Error(`Member ${input.memberId} not found`);
  if (!klass) throw new Error(`Class ${input.classId} not found`);
  if (klass.status === 'cancelled') throw new Error(`${klass.name} has been cancelled`);

  const priceCents = input.priceCents ?? DEFAULT_DROP_IN_PRICE_CENTS;
  const currency = member.currency ?? 'usd';
  const at = ctx.now().toISOString();

  const invoice = await createInvoice(ctx, {
    memberId: member.id,
    currency,
    lineItems: [
      {
        description: `Drop-in - ${klass.name}`,
        quantity: 1,
        unitAmountCents: priceCents,
        kind: 'drop-in',
        metadata: { classId: klass.id },
      },
    ],
  });

  let paymentId: string | undefined;
  let charged = false;
  let failureCode: string | undefined;

  if (input.gateway) {
    const payment = await input.gateway.createPayment({
      amountCents: priceCents,
      currency,
      description: `Drop-in: ${klass.name}`,
      memberId: member.id,
      idempotencyKey: input.idempotencyKey ?? chargeKey('drop-in', member.id, invoice.id),
      metadata: { memberId: member.id, invoiceId: invoice.id, classId: klass.id, kind: 'drop-in' },
    });
    paymentId = payment.id;
    if (payment.status === 'failed') {
      failureCode = payment.failureCode;
      await ctx.events.emit('payment.failed', {
        chargeId: payment.id,
        memberId: member.id,
        failureCode: payment.failureCode,
      });
      return {
        dropIn: undefined as never,
        invoiceId: invoice.id,
        charged: false,
        paymentId,
        waitlisted: false,
        amountCents: priceCents,
        failureCode,
      };
    }
    await markPaid(ctx, invoice.id, priceCents);
    charged = payment.status === 'succeeded';
  } else {
    await markPaid(ctx, invoice.id, priceCents);
    charged = true;
  }

  const dropIn = await dropInsRepo(ctx).insert({
    id: newDropInId(),
    studioId: ctx.studioId,
    memberId: member.id,
    classId: klass.id,
    priceCents,
    currency,
    purchasedAt: at,
    paymentId,
    status: 'active',
    createdAt: at,
  });

  let bookingId: string | undefined;
  let waitlisted = false;
  if (input.autoBook !== false) {
    try {
      const result = await createBooking(ctx, {
        memberId: member.id,
        classId: klass.id,
        source: 'web',
        // A drop-in is money in hand - always seat them, even if it looks full.
        override: false,
        allowWaitlist: true,
      });
      bookingId = result.booking.id;
      waitlisted = result.booking.status === 'waitlisted';
      if (waitlisted) {
        await dropInsRepo(ctx).update(dropIn.id, { status: 'active' });
      }
    } catch (error) {
      // Paid but could not book (member cancelled/paused since checkout).
      // The drop-in is still valid - staff can seat them manually.
      void error;
    }
  }

  return { dropIn, invoiceId: invoice.id, charged, paymentId, bookingId, waitlisted, amountCents: priceCents };
}

export async function listDropIns(
  ctx: CoreContext,
  query: { memberId?: string; classId?: string; status?: DropIn['status'] } = {},
): Promise<DropIn[]> {
  const filter: Record<string, unknown> = {};
  if (query.memberId) filter.memberId = query.memberId;
  if (query.classId) filter.classId = query.classId;
  if (query.status) filter.status = query.status;
  const rows = await dropInsRepo(ctx).list({ filter: filter as never });
  return sortBy(rows, (d) => d.purchasedAt, 'desc');
}

export async function refundDropIn(
  ctx: CoreContext,
  dropInId: string,
  gateway?: PaymentGateway,
): Promise<{ dropIn: DropIn; refunded: boolean; refundId?: string }> {
  const dropIn = await dropInsRepo(ctx).findById(dropInId);
  if (!dropIn) throw new Error(`Drop-in ${dropInId} not found`);
  if (dropIn.status === 'refunded') return { dropIn, refunded: false };

  let refundId: string | undefined;
  if (gateway && dropIn.paymentId) {
    const refund = await gateway.refund(dropIn.paymentId, dropIn.priceCents);
    refundId = refund.id;
  }

  const updated = await dropInsRepo(ctx).update(dropInId, { status: 'refunded' });

  // Cancel the booking if it has not started yet.
  const booking = await ctx.repo.table('bookings').findOne({
                                                    filter: {
    memberId: dropIn.memberId,
    classId: dropIn.classId,
    status: 'booked',
  
                                                  },
                                                  } as never);
  if (booking) {
    const { cancelBooking } = await import('@studiodesk/core');
    await cancelBooking(ctx, booking.id, { waived: true, waiverReason: 'studio-error', reason: 'Drop-in refunded' });
  }

  return { dropIn: updated, refunded: true, refundId };
}

/** Drop-in revenue for a class - used by the revenue report. */
export async function classDropInRevenue(ctx: CoreContext, classId: string): Promise<number> {
  const dropIns = await dropInsRepo(ctx).list({ filter: { classId, status: 'active' } });
  return dropIns.reduce((acc, dropIn) => acc + dropIn.priceCents, 0);
}

/** Which classes still sell drop-ins (not cancelled, in the future). */
export async function dropInEligibleClasses(ctx: CoreContext) {
  const classes = await ctx.repo.table('classes').list({
    filter: { from: ctx.now().toISOString(), status: 'scheduled' },
    limit: 500,
  });
  return sortBy(classes, (c) => c.startTime, 'asc');
}