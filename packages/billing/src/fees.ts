import { newFeeId, sortBy, type Fee, type FeeKind, type FeeWaiverReason } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { createInvoice, markPaid } from './invoices.js';
import { chargeKey } from './stripe.js';
import type { PaymentGateway, SubscriberHandle } from './gateway.js';

export function feesRepo(ctx: CoreContext) {
  return ctx.repo.table('fees');
}

export const DEFAULT_LATE_CANCEL_FEE_CENTS = 300;
export const DEFAULT_NO_SHOW_FEE_CENTS = 500;

/* -------------------------------------------------------------------------- */
/* Assessment                                                                 */
/* -------------------------------------------------------------------------- */

export interface AssessFeeInput {
  memberId: string;
  classId?: string;
  bookingId?: string;
  kind: FeeKind;
  amountCents?: number;
  note?: string;
  /** Charge the member's card immediately. */
  charge?: boolean;
  gateway?: PaymentGateway;
  /** Never charge twice for the same booking + kind. */
  idempotent?: boolean;
}

export interface AssessFeeResult {
  fee: Fee;
  charged: boolean;
  invoiceId?: string;
  duplicate: boolean;
}

/**
 * Assesses a late-cancel or no-show fee and (optionally) bills it.
 *
 * Idempotent by default: `booking.cancelled` and `class.completed` both fire on
 * the same booking, and the member must never be charged twice.
 */
export async function assessFee(
  ctx: CoreContext,
  input: AssessFeeInput,
): Promise<AssessFeeResult> {
  if (input.idempotent !== false && input.bookingId) {
    const existing = await feesRepo(ctx).findOne({ filter: { bookingId: input.bookingId, kind: input.kind } } as never);
    if (existing) return { fee: existing, charged: existing.status === 'charged', duplicate: true };
  }

  const member = await ctx.repo.table('members').findById(input.memberId);
  if (!member) throw new Error(`Member ${input.memberId} not found`);

  const amountCents = input.amountCents ?? defaultAmountFor(input.kind);
  const at = ctx.now().toISOString();

  const fee = await feesRepo(ctx).insert({
    id: newFeeId(),
    studioId: ctx.studioId,
    memberId: input.memberId,
    classId: input.classId,
    bookingId: input.bookingId,
    kind: input.kind,
    amountCents,
    currency: member.currency ?? 'usd',
    status: amountCents === 0 ? 'waived' : 'assessed',
    assessedAt: at,
    note: input.note,
    createdAt: at,
  });

  await ctx.events.emit('fee.assessed', {
    feeId: fee.id,
    memberId: input.memberId,
    amountCents,
    kind: input.kind,
  });

  if (amountCents > 0 && input.charge && input.gateway) {
    const invoice = await createInvoice(ctx, {
      memberId: input.memberId,
      currency: member.currency ?? 'usd',
      lineItems: [
        {
          description: feeLabel(input.kind),
          quantity: 1,
          unitAmountCents: amountCents,
          kind: input.kind === 'no-show' ? 'no-show-fee' : 'late-cancel-fee',
          metadata: { feeId: fee.id, classId: input.classId ?? '' },
        },
      ],
    });

    const payment = await input.gateway.createPayment({
      amountCents,
      currency: member.currency ?? 'usd',
      description: feeLabel(input.kind),
      memberId: input.memberId,
      idempotencyKey: chargeKey(input.kind === 'no-show' ? 'no-show' : 'late-cancel', input.memberId, fee.id),
      metadata: { memberId: input.memberId, feeId: fee.id, invoiceId: invoice.id },
    });

    if (payment.status === 'failed') {
      await ctx.events.emit('payment.failed', {
        chargeId: payment.id,
        memberId: input.memberId,
        failureCode: payment.failureCode,
      });
      return { fee, charged: false, invoiceId: invoice.id, duplicate: false };
    }

    await markPaid(ctx, invoice.id, amountCents);
    const updated = await feesRepo(ctx).update(fee.id, {
      status: 'charged',
      chargedAt: ctx.now().toISOString(),
    });
    return { fee: updated, charged: true, invoiceId: invoice.id, duplicate: false };
  }

  return { fee, charged: false, duplicate: false };
}

function defaultAmountFor(kind: FeeKind): number {
  if (kind === 'no-show') return DEFAULT_NO_SHOW_FEE_CENTS;
  if (kind === 'late-cancel') return DEFAULT_LATE_CANCEL_FEE_CENTS;
  return 0;
}

export function feeLabel(kind: FeeKind): string {
  if (kind === 'no-show') return 'No-show fee';
  if (kind === 'late-cancel') return 'Late cancellation fee';
  return 'Cancellation fee';
}

/* -------------------------------------------------------------------------- */
/* Waivers / voiding                                                          */
/* -------------------------------------------------------------------------- */

export async function waiveFee(
  ctx: CoreContext,
  feeId: string,
  reason: FeeWaiverReason,
  note?: string,
): Promise<Fee> {
  const fee = await feesRepo(ctx).findById(feeId);
  if (!fee) throw new Error(`Fee ${feeId} not found`);
  const updated = await feesRepo(ctx).update(feeId, {
    status: 'waived',
    waivedAt: ctx.now().toISOString(),
    waiverReason: reason,
    note: note ?? fee.note,
  });
  await ctx.events.emit('fee.waived', { feeId, memberId: fee.memberId });
  return updated;
}

export async function voidFee(ctx: CoreContext, feeId: string, note?: string): Promise<Fee> {
  const fee = await feesRepo(ctx).findById(feeId);
  if (!fee) throw new Error(`Fee ${feeId} not found`);
  return feesRepo(ctx).update(feeId, { status: 'void', note: note ?? fee.note });
}

/* -------------------------------------------------------------------------- */
/* Bulk operations                                                            */
/* -------------------------------------------------------------------------- */

export interface ChargeFeesResult {
  attempted: number;
  charged: number;
  failed: number;
  totalCents: number;
  failures: Array<{ feeId: string; code?: string }>;
}

/** Chases every outstanding fee onto a card. Used by the dunning runner. */
export async function chargeOutstandingFees(
  ctx: CoreContext,
  gateway: PaymentGateway,
  options: { limit?: number; memberId?: string } = {},
): Promise<ChargeFeesResult> {
  const fees = await feesRepo(ctx).list({
    filter: {
      status: 'assessed',
      ...(options.memberId ? { memberId: options.memberId } : {}),
    },
  });
  const slice = options.limit ? fees.slice(0, options.limit) : fees;
  const result: ChargeFeesResult = { attempted: 0, charged: 0, failed: 0, totalCents: 0, failures: [] };

  for (const fee of slice) {
    result.attempted += 1;
    try {
      const outcome = await assessFee(ctx, {
        memberId: fee.memberId,
        classId: fee.classId,
        bookingId: fee.bookingId,
        kind: fee.kind,
        amountCents: fee.amountCents,
        charge: true,
        gateway,
        idempotent: true,
      });
      if (outcome.charged) {
        result.charged += 1;
        result.totalCents += fee.amountCents;
      } else {
        result.failed += 1;
        result.failures.push({ feeId: fee.id });
      }
    } catch (error) {
      result.failed += 1;
      result.failures.push({ feeId: fee.id, code: error instanceof Error ? error.message.slice(0, 40) : 'error' });
    }
  }
  return result;
}

export async function listFees(
  ctx: CoreContext,
  query: { memberId?: string; classId?: string; status?: Fee['status']; kind?: FeeKind; limit?: number } = {},
): Promise<Fee[]> {
  const filter: Record<string, unknown> = {};
  if (query.memberId) filter.memberId = query.memberId;
  if (query.classId) filter.classId = query.classId;
  if (query.status) filter.status = query.status;
  if (query.kind) filter.kind = query.kind;
  const rows = await feesRepo(ctx).list({ filter: filter as never });
  const sorted = sortBy(rows, (f) => f.assessedAt, 'desc');
  return query.limit ? sorted.slice(0, query.limit) : sorted;
}

export async function outstandingFees(ctx: CoreContext, memberId?: string): Promise<Fee[]> {
  return feesRepo(ctx).list({ filter: { status: 'assessed', ...(memberId ? { memberId } : {}) } });
}

/* -------------------------------------------------------------------------- */
/* Event wiring                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Connects fee assessment to domain events:
 *
 *   booking.cancelled (late)  -> late-cancel fee
 *   class.completed           -> no-show fee per no-show
 *   class.cancelled           -> waive every fee on that class
 *
 * Returns a handle so tests (and shutdown) can detach cleanly.
 */
export function connectFees(
  ctx: CoreContext,
  gateway?: PaymentGateway,
  options: { autoCharge?: boolean } = {},
): SubscriberHandle {
  const settingsFee = async (kind: FeeKind): Promise<number> => {
    const { getStudioSettings } = await import('@studiodesk/core');
    const settings = await getStudioSettings(ctx);
    return kind === 'no-show'
      ? ((settings.noShowFeeCents as number) ?? DEFAULT_NO_SHOW_FEE_CENTS)
      : ((settings.lateCancelFeeCents as number) ?? DEFAULT_LATE_CANCEL_FEE_CENTS);
  };

  const onLateCancel = ctx.events.on('booking.cancelled', async ({ bookingId, memberId, classId, late }) => {
    if (!late) return;
    const amount = await settingsFee('late-cancel');
    if (amount <= 0) return;
    await assessFee(ctx, {
      memberId,
      classId,
      bookingId,
      kind: 'late-cancel',
      amountCents: amount,
      note: 'Cancelled inside the late-cancel window',
      charge: options.autoCharge === true,
      gateway,
    });
  });

  const onClassCompleted = ctx.events.on('class.completed', async ({ classId, noShows }) => {
    if (noShows <= 0) return;
    const amount = await settingsFee('no-show');
    if (amount <= 0) return;
    const bookings = await ctx.repo.table('bookings').list({ filter: { classId, status: 'no-show' } });
    for (const booking of bookings) {
      await assessFee(ctx, {
        memberId: booking.memberId,
        classId,
        bookingId: booking.id,
        kind: 'no-show',
        amountCents: amount,
        note: 'Booked but did not check in',
        charge: options.autoCharge === true,
        gateway,
      });
    }
  });

  const onClassCancelled = ctx.events.on('class.cancelled', async ({ classId }) => {
    const fees = await feesRepo(ctx).list({ filter: { classId, status: 'assessed' } });
    for (const fee of fees) {
      await waiveFee(ctx, fee.id, 'instructor-cancel', 'Class cancelled by the studio');
    }
  });

  return {
    dispose: () => {
      onLateCancel();
      onClassCompleted();
      onClassCancelled();
    },
  };
}

export { SubscriberHandle as FeeSubscriberHandle };