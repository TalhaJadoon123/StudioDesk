import { toCents, type Currency } from '@studiodesk/shared';
import {
  createStripeGateway,
  verifyStripeSignature,
  type StripeConfig,
  type StripeGateway,
} from './gateway.js';

/**
 * Stripe integration - **per-transaction only**.
 *
 * Stripe's recurring billing is deliberately not used: StudioDesk runs
 * memberships through Polar (open source, 4% + 40c) or Lemon Squeezy
 * (Pakistan-friendly), and keeps Stripe for one-off charges where the
 * per-transaction pricing (2.9% + 30c) is unbeatable and there is no monthly
 * fee to worry about.
 *
 * Used for: class packs, drop-ins, late-cancel and no-show fees, and manual
 * top-ups taken at the desk.
 */

/* -------------------------------------------------------------------------- */
/* Fees                                                                       */
/* -------------------------------------------------------------------------- */

export interface FeeBreakdown {
  baseCents: number;
  percentageCents: number;
  fixedCents: number;
  totalCents: number;
  /** What the studio nets after Stripe takes its cut. */
  netCents: number;
}

/** Stripe US pricing: 2.9% + 30c per successful card charge. */
export const STRIPE_PERCENTAGE = 0.029;
export const STRIPE_FIXED_CENTS = 30;

/** Polar's flat pricing: 4% + 40c, no monthly fee. */
export const POLAR_PERCENTAGE = 0.04;
export const POLAR_FIXED_CENTS = 40;

/**
 * Both processors have a fixed component, so a very small charge can cost more
 * than it is worth. `netCents` is clamped at zero - the studio is never billed
 * more than the member paid - and `MIN_CHARGE_CENTS` is the amount below which
 * another gateway is the better choice.
 */
function buildFee(
  baseCents: number,
  percentage: number,
  fixedCents: number,
): FeeBreakdown {
  const base = Math.round(baseCents);
  const percentageCents = Math.round(base * percentage);
  const totalCents = percentageCents + fixedCents;
  return {
    baseCents: base,
    percentageCents,
    fixedCents,
    totalCents,
    netCents: Math.max(0, base - totalCents),
  };
}

/** Below this, fixed fees dominate: 30c on a $0.30 charge is 10%. */
export const MIN_CHARGE_CENTS = 500;

export function stripeFee(amountCents: number, currency: Currency = 'usd'): FeeBreakdown {
  void currency;
  return buildFee(amountCents, STRIPE_PERCENTAGE, STRIPE_FIXED_CENTS);
}

export function polarFee(amountCents: number): FeeBreakdown {
  return buildFee(amountCents, POLAR_PERCENTAGE, POLAR_FIXED_CENTS);
}

/**
 * Works out the platform fee for an amount, choosing the cheaper gateway.
 * A $5 no-show fee costs more in fixed fees than it does in percentage fees -
 * this keeps that honest.
 */
export function cheapestGateway(
  amountCents: number,
  available: { stripe: boolean; polar: boolean },
): { gateway: 'stripe' | 'polar'; breakdown: FeeBreakdown } | null {
  const options: Array<{ gateway: 'stripe' | 'polar'; breakdown: FeeBreakdown }> = [];
  if (available.stripe) options.push({ gateway: 'stripe', breakdown: stripeFee(amountCents) });
  if (available.polar) options.push({ gateway: 'polar', breakdown: polarFee(amountCents) });
  if (!options.length) return null;
  // "Cheapest" means the highest net payout, i.e. the lowest total fee.
  return options.sort((a, b) => a.breakdown.totalCents - b.breakdown.totalCents)[0]!;
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Stable key for a charge so a retried webhook or a double tap can never
 * double-charge a member. Format: `<kind>:<memberId>:<reference>`.
 */
export function chargeKey(
  kind: 'membership' | 'class-pack' | 'drop-in' | 'late-cancel' | 'no-show' | 'manual',
  memberId: string,
  reference: string,
): string {
  return `sd_${kind}_${memberId}_${reference}`;
}

/** Invoice number a human would recognise: `INV-2026-0007`. */
export function invoiceNumber(sequence: number, year = new Date().getUTCFullYear()): string {
  return `INV-${year}-${String(sequence).padStart(4, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export interface StripeWebhookResult {
  handled: boolean;
  /** Stripe event name, e.g. `payment_intent.succeeded`. */
  type: string;
  paymentIntentId?: string;
  amountCents?: number;
  failureCode?: string;
  metadata: Record<string, string>;
}

export interface WebhookOutcome {
  /** Domain event to emit, if any. */
  emit?: string;
  memberId?: string;
  payload: Record<string, unknown>;
}

/**
 * Translates a verified Stripe webhook into something the billing layer can act
 * on. Kept pure so it is trivially testable against recorded payloads.
 */
export function handleStripeWebhook(event: StripeWebhookResult): WebhookOutcome {
  const metadata = event.metadata ?? {};
  const memberId = metadata.memberId;

  switch (event.type) {
    case 'payment_intent.succeeded':
      return {
        emit: 'payment.succeeded',
        memberId,
        payload: { chargeId: event.paymentIntentId, amountCents: event.amountCents, memberId },
      };
    case 'payment_intent.payment_failed':
      return {
        emit: 'payment.failed',
        memberId,
        payload: {
          chargeId: event.paymentIntentId,
          memberId,
          failureCode: event.failureCode,
          amountCents: event.amountCents,
        },
      };
    case 'charge.refunded':
      return { memberId, payload: { chargeId: event.paymentIntentId, amountCents: event.amountCents } };
    default:
      return { payload: { ignored: event.type } };
  }
}

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                 */
/* -------------------------------------------------------------------------- */

export { createStripeGateway, verifyStripeSignature };
export type { StripeConfig, StripeGateway };

/** Convenience: build a Stripe gateway, or `null` when no key is configured. */
export function stripeFromEnv(): StripeGateway | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? createStripeGateway({ secretKey: key }) : null;
}

export { toCents };