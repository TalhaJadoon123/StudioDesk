import { describe, expect, it, beforeEach } from 'vitest';
import {
  POLAR_FIXED_CENTS,
  POLAR_PERCENTAGE,
  STRIPE_FIXED_CENTS,
  STRIPE_PERCENTAGE,
  chargeKey,
  cheapestGateway,
  createGateways,
  createManualGateway,
  createMockGateway,
  handleStripeWebhook,
  invoiceNumber,
  polarFee,
  stripeFee,
  verifyHmac,
} from '@studiodesk/billing';

describe('gateway fees', () => {
  it('matches Stripe per-transaction pricing (2.9% + 30c)', () => {
    const fee = stripeFee(10_000);
    expect(fee.percentageCents).toBe(290);
    expect(fee.fixedCents).toBe(STRIPE_FIXED_CENTS);
    expect(fee.totalCents).toBe(320);
    expect(fee.netCents).toBe(9_680);
    expect(STRIPE_PERCENTAGE).toBe(0.029);
  });

  it('matches Polar pricing (4% + 40c)', () => {
    const fee = polarFee(10_000);
    expect(fee.percentageCents).toBe(400);
    expect(fee.fixedCents).toBe(POLAR_FIXED_CENTS);
    expect(fee.netCents).toBe(9_560);
    expect(POLAR_PERCENTAGE).toBe(0.04);
  });

  it('picks the cheaper gateway per charge', () => {
    // A large charge: Stripe's lower percentage wins.
    expect(cheapestGateway(100_000, { stripe: true, polar: true })!.gateway).toBe('stripe');
    // A tiny fee: fixed costs dominate, so the lower fixed fee wins.
    expect(cheapestGateway(500, { stripe: true, polar: true })!.gateway).toBe('stripe');
    expect(cheapestGateway(5000, { stripe: false, polar: true })!.gateway).toBe('polar');
    expect(cheapestGateway(5000, { stripe: false, polar: false })).toBeNull();
  });

  it('rounds to whole cents', () => {
    // 333 * 0.029 = 9.657 -> 10
    expect(stripeFee(333).percentageCents).toBe(10);
  });
});

describe('mock gateway', () => {
  let gateway: ReturnType<typeof createMockGateway>;

  beforeEach(() => {
    gateway = createMockGateway();
  });

  it('records every call', async () => {
    await gateway.createCustomer({ memberId: 'mem_1', name: 'Ada' });
    await gateway.createPayment({ amountCents: 1000, currency: 'usd', description: 'Test' });
    expect(gateway.state.calls.map((c) => c.method)).toEqual(['createCustomer', 'createPayment']);
    expect(gateway.state.payments).toHaveLength(1);
    expect(gateway.state.payments[0]!.status).toBe('succeeded');
  });

  it('reuses the customer for the same member', async () => {
    const a = await gateway.createCustomer({ memberId: 'mem_1', name: 'Ada' });
    const b = await gateway.createCustomer({ memberId: 'mem_1', name: 'Ada' });
    expect(a.id).toBe(b.id);
    expect(gateway.state.customers).toHaveLength(1);
  });

  it('is idempotent for a repeated charge key', async () => {
    const key = chargeKey('class-pack', 'mem_1', 'inv_1');
    const first = await gateway.createPayment({
      amountCents: 1000,
      currency: 'usd',
      description: 'Pack',
      idempotencyKey: key,
    });
    const second = await gateway.createPayment({
      amountCents: 1000,
      currency: 'usd',
      description: 'Pack',
      idempotencyKey: key,
    });
    expect(second.id).toBe(first.id);
    expect(gateway.state.payments).toHaveLength(1);
  });

  it('can simulate a decline once', async () => {
    gateway.failNext('insufficient_funds', 'Card declined');
    const failed = await gateway.createPayment({
      amountCents: 1000,
      currency: 'usd',
      description: 'Pack',
    });
    expect(failed.status).toBe('failed');
    expect(failed.failureCode).toBe('insufficient_funds');

    const next = await gateway.createPayment({
      amountCents: 1000,
      currency: 'usd',
      description: 'Pack',
    });
    expect(next.status).toBe('succeeded');
  });

  it('refunds and cancels subscriptions', async () => {
    const sub = await gateway.createSubscription({
      customerId: 'cus_1',
      memberId: 'mem_1',
      productId: 'prod_1',
      amountCents: 3900,
      currency: 'usd',
      interval: 'month',
    });
    expect(sub.status).toBe('active');
    const cancelled = await gateway.cancelSubscription(sub.id);
    expect(cancelled.status).toBe('cancelled');

    const refund = await gateway.refund('pi_1', 500);
    expect(refund.status).toBe('succeeded');
    expect(gateway.state.refunds).toHaveLength(1);
  });

  it('resets', async () => {
    await gateway.createPayment({ amountCents: 1, currency: 'usd', description: 'x' });
    gateway.reset();
    expect(gateway.state.payments).toHaveLength(0);
    expect(gateway.state.calls).toHaveLength(0);
  });
});

describe('manual gateway', () => {
  it('succeeds offline so the app is usable with no keys', async () => {
    const gateway = createManualGateway();
    const payment = await gateway.createPayment({
      amountCents: 2200,
      currency: 'usd',
      description: 'Drop-in',
    });
    expect(payment.status).toBe('succeeded');

    const sub = await gateway.createSubscription({
      customerId: 'cus_manual',
      memberId: 'mem_1',
      productId: 'p',
      amountCents: 3900,
      currency: 'usd',
      interval: 'month',
    });
    expect(sub.status).toBe('active');
    expect(Date.parse(sub.currentPeriodEnd)).toBeGreaterThan(Date.parse(sub.currentPeriodStart));
  });
});

describe('createGateways', () => {
  it('falls back to manual when nothing is configured', () => {
    const gateways = createGateways();
    expect(gateways.hasPayments).toBe(false);
    expect(gateways.recurring.name).toBe('manual');
    expect(gateways.byName.stripe.name).toBe('manual');
  });

  it('prefers an injected mock for recurring billing', () => {
    const mock = createMockGateway({ name: 'polar' });
    const gateways = createGateways({ polar: mock, recurring: mock });
    expect(gateways.recurring).toBe(mock);
    expect(gateways.active).toBe('polar');
    expect(gateways.hasPayments).toBe(true);
  });
});

describe('idempotency keys and invoice numbers', () => {
  it('builds stable charge keys', () => {
    expect(chargeKey('membership', 'mem_1', 'inv_9')).toBe('sd_membership_mem_1_inv_9');
    expect(chargeKey('membership', 'mem_1', 'inv_9')).toBe(chargeKey('membership', 'mem_1', 'inv_9'));
    expect(chargeKey('no-show', 'mem_1', 'inv_9')).not.toBe(chargeKey('late-cancel', 'mem_1', 'inv_9'));
  });

  it('formats invoice numbers', () => {
    expect(invoiceNumber(1, 2026)).toBe('INV-2026-0001');
    expect(invoiceNumber(1234, 2026)).toBe('INV-2026-1234');
  });
});

describe('webhook translation', () => {
  it('maps a successful payment to a domain event', () => {
    const outcome = handleStripeWebhook({
      handled: true,
      type: 'payment_intent.succeeded',
      paymentIntentId: 'pi_1',
      amountCents: 8900,
      metadata: { memberId: 'mem_1' },
    });
    expect(outcome.emit).toBe('payment.succeeded');
    expect(outcome.memberId).toBe('mem_1');
    expect(outcome.payload.amountCents).toBe(8900);
  });

  it('maps a failure', () => {
    const outcome = handleStripeWebhook({
      handled: true,
      type: 'payment_intent.payment_failed',
      paymentIntentId: 'pi_1',
      failureCode: 'card_declined',
      metadata: { memberId: 'mem_2' },
    });
    expect(outcome.emit).toBe('payment.failed');
    expect(outcome.payload.failureCode).toBe('card_declined');
  });

  it('ignores events it does not care about', () => {
    const outcome = handleStripeWebhook({
      handled: false,
      type: 'customer.created',
      metadata: {},
    });
    expect(outcome.emit).toBeUndefined();
    expect(outcome.payload.ignored).toBe('customer.created');
  });
});

describe('verifyHmac', () => {
  async function sign(payload: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('accepts a valid signature and rejects tampering', async () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const signature = await sign(body, secret);
    expect(await verifyHmac(body, `v1=${signature}`, secret, 0)).toBe(true);
    expect(await verifyHmac(`${body}x`, `v1=${signature}`, secret, 0)).toBe(false);
    expect(await verifyHmac(body, `v1=${signature}`, 'other', 0)).toBe(false);
    expect(await verifyHmac(body, 'garbage', secret, 0)).toBe(false);
  });
});