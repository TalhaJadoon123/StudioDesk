import { describe, expect, it } from 'vitest';
import {
  createGateways,
  createMockGateway,
  createStripeGateway,
  MIN_CHARGE_CENTS,
  polarFee,
  stripeFee,
  verifyHmac,
  verifyStripeSignature,
} from '@studiodesk/billing';

/**
 * Contract tests against recorded, real-shaped payloads. These catch the
 * mistakes that actually happen: a field renamed upstream, a signature built
 * over the wrong body, a status we do not map.
 */

async function hmacHex(payload: string, secret: string): Promise<string> {
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

describe('Stripe webhook signature contract', () => {
  const secret = 'whsec_test_secret';

  it('accepts a correctly signed payload', async () => {
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', amount: 8900, metadata: { memberId: 'mem_1' } } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex(`${timestamp}.${body}`, secret);
    const header = `t=${timestamp},v1=${signature}`;

    expect(await verifyStripeSignature(body, header, secret)).toBe(true);
  });

  it('rejects a payload modified after signing', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex(`${timestamp}.${body}`, secret);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'payment_intent.payment_failed' });

    expect(await verifyStripeSignature(tampered, `t=${timestamp},v1=${signature}`, secret)).toBe(false);
  });

  it('rejects a stale timestamp (replay window)', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const old = Math.floor(Date.now() / 1000) - 3600;
    const signature = await hmacHex(`${old}.${body}`, secret);

    expect(await verifyStripeSignature(body, `t=${old},v1=${signature}`, secret)).toBe(false);
  });

  it('rejects a malformed header', async () => {
    const body = '{}';
    expect(await verifyStripeSignature(body, 'garbage', secret)).toBe(false);
    expect(await verifyStripeSignature(body, 't=123', secret)).toBe(false);
  });

  it('accepts any of several valid v1 signatures (rotation)', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const timestamp = Math.floor(Date.now() / 1000);
    const good = await hmacHex(`${timestamp}.${body}`, secret);
    const header = `t=${timestamp},v1=deadbeef,v1=${good}`;
    expect(await verifyStripeSignature(body, header, secret)).toBe(true);
  });
});

describe('Polar webhook contract', () => {
  const secret = 'polar_webhook_test';

  it('validates the Polar signature scheme', async () => {
    const body = JSON.stringify({
      type: 'subscription.created',
      data: { id: 'sub_1', external_id: 'mem_1' },
    });
    const signature = await hmacHex(body, secret);
    // Polar sends a bare signature; our adapter wraps it as v1=<sig>.
    expect(await verifyHmac(body, `v1=${signature}`, secret, 0)).toBe(true);
    expect(await verifyHmac(body, `v1=${signature}`, 'wrong', 0)).toBe(false);
  });
});

describe('gateway degradation', () => {
  it('never throws when an SDK is missing', () => {
    // The Stripe adapter is constructed lazily and must not touch `stripe` at
    // import time - StudioDesk talks to the REST API directly.
    const gateway = createStripeGateway({ secretKey: 'sk_test_dummy' });
    expect(gateway.name).toBe('stripe');
    expect(typeof gateway.createPayment).toBe('function');
  });

  it('refuses to treat Stripe as a recurring gateway', async () => {
    const gateway = createStripeGateway({ secretKey: 'sk_test_dummy' });
    await expect(
      gateway.createSubscription({
        customerId: 'cus_1',
        memberId: 'mem_1',
        productId: 'p',
        amountCents: 100,
        currency: 'usd',
        interval: 'month',
      }),
    ).rejects.toThrow(/one-off payments only/);
  });

  it('falls back to offline mode with no keys', () => {
    const gateways = createGateways();
    expect(gateways.hasPayments).toBe(false);
    expect(gateways.recurring.name).toBe('manual');
    expect(gateways.oneOff.name).toBe('manual');
  });

  it('uses the mock for both roles when injected', () => {
    const mock = createMockGateway({ name: 'stripe' });
    const gateways = createGateways({ stripe: mock, recurring: mock });
    expect(gateways.oneOff).toBe(mock);
    expect(gateways.hasPayments).toBe(true);
  });
});

describe('pricing constants stay honest', () => {
  it('matches the published rates', () => {
    // Stripe: 2.9% + 30c. Polar: 4% + 40c. If these change, the docs must too.
    expect(stripeFee(10_000).totalCents).toBe(320);
    expect(polarFee(10_000).totalCents).toBe(440);
  });

  it('never returns a negative net, even on a tiny charge', () => {
    // 30c of fixed fee on a 1c charge would otherwise "pay" the studio 29c.
    for (const amount of [1, 30, 100, 5_000, 15_000, 100_000]) {
      expect(stripeFee(amount).netCents).toBeGreaterThanOrEqual(0);
      expect(polarFee(amount).netCents).toBeGreaterThanOrEqual(0);
    }
    expect(stripeFee(1).netCents).toBe(0);
    expect(stripeFee(1).totalCents).toBe(30);
  });

  it('flags the range where fixed fees dominate', () => {
    expect(MIN_CHARGE_CENTS).toBe(500);
    // Below the floor the flat 30c is more than 6% of the charge.
    expect(stripeFee(499).fixedCents / 499).toBeGreaterThan(0.05);
  });
});

describe('HMAC timing safety', () => {
  it('rejects a signature of the wrong length without throwing', async () => {
    const body = 'payload';
    const signature = await hmacHex(body, 'secret');
    expect(await verifyHmac(body, `v1=${signature.slice(0, 10)}`, 'secret', 0)).toBe(false);
    expect(await verifyHmac(body, `v1=${signature}00`, 'secret', 0)).toBe(false);
  });
});
