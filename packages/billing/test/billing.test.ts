import { beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '@studiodesk/core';
import {
  addLineItem,
  assessFee,
  changePlan,
  connectBilling,
  connectFees,
  consolidateBalance,
  createInvoice,
  createMockGateway,
  dunningSummary,
  expirePacks,
  listFees,
  listInvoices,
  listMemberships,
  markPaid,
  openInvoicesFor,
  outstandingBalance,
  packHealth,
  purchaseDropIn,
  purchasePack,
  recoverNow,
  recurringRevenue,
  registerFailedPayment,
  registerSuccessfulPayment,
  renewDueMemberships,
  runDunning,
  subscribe,
} from '@studiodesk/billing';
import {
  harness,
  seedClass,
  seedInstructor,
  seedMembers,
  seedPlan,
  seedStudio,
  type Harness,
} from '@studiodesk/core/test';

let h: Harness;
let ctx: ReturnType<typeof createContext>;
let gateway: ReturnType<typeof createMockGateway>;

/** Every test needs members; the plan-only tests use the shared `plan_unlimited`. */
async function setupMembers(count: number, prefix = 'mem'): Promise<void> {
  await seedMembers(h, count, () => ({}), { prefix });
}

beforeEach(async () => {
  h = harness(new Date('2026-03-02T09:00:00.000Z'));
  ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
  await seedStudio(h, 'business');
  await seedInstructor(h);
  await seedPlan(h, {
    id: 'plan_unlimited',
    name: 'Unlimited Monthly',
    priceCents: 8900,
    classCredits: null,
  });
  gateway = createMockGateway();
});

describe('invoices', () => {
  it('derives totals from line items', async () => {
    await setupMembers(1);
    const invoice = await createInvoice(ctx, {
      memberId: 'mem_001',
      lineItems: [
        { description: '10 Class Pack', quantity: 1, unitAmountCents: 15_000, kind: 'class-pack' },
        { description: 'Drop-in', quantity: 2, unitAmountCents: 2200, kind: 'drop-in' },
      ],
    });
    expect(invoice.subtotalCents).toBe(19_400);
    expect(invoice.totalCents).toBe(19_400);
    expect(invoice.amountDueCents).toBe(19_400);
    expect(invoice.status).toBe('open');
    expect(invoice.lineItems[1]!.amountCents).toBe(4400);
  });

  it('marks paid and emits an event', async () => {
    let emitted = 0;
    h.events.on('invoice.paid', () => {
      emitted += 1;
    });
    const invoice = await createInvoice(ctx, {
      memberId: 'mem_001',
      lineItems: [{ description: 'x', unitAmountCents: 500, kind: 'membership' }],
    });
    const paid = await markPaid(ctx, invoice.id, 500);
    expect(paid.status).toBe('paid');
    expect(paid.amountDueCents).toBe(0);
    expect(emitted).toBe(1);
  });

  it('adds line items and recalculates', async () => {
    await setupMembers(1);
    const invoice = await createInvoice(ctx, {
      memberId: 'mem_001',
      lineItems: [{ description: 'Pack', unitAmountCents: 9000, kind: 'class-pack' }],
    });
    const updated = await addLineItem(ctx, invoice.id, {
      description: 'No-show fee',
      unitAmountCents: 500,
      kind: 'no-show-fee',
    });
    expect(updated.totalCents).toBe(9500);
    expect(updated.amountDueCents).toBe(9500);
  });

  it('refuses to modify a paid invoice', async () => {
    const invoice = await createInvoice(ctx, {
      lineItems: [{ description: 'x', unitAmountCents: 100, kind: 'membership' }],
    });
    await markPaid(ctx, invoice.id);
    await expect(
      addLineItem(ctx, invoice.id, { description: 'y', unitAmountCents: 100, kind: 'membership' }),
    ).rejects.toThrow(/paid/);
  });

  it('requires at least one line item', async () => {
    await expect(createInvoice(ctx, { lineItems: [] })).rejects.toThrow(/no line items/);
  });

  it('computes outstanding balances and consolidates fees', async () => {
    await setupMembers(1);
    const invoice = await createInvoice(ctx, {
      memberId: 'mem_001',
      lineItems: [{ description: 'Pack', unitAmountCents: 9000, kind: 'class-pack' }],
    });
    expect(await outstandingBalance(ctx, 'mem_001')).toBe(9000);

    await assessFee(ctx, { memberId: 'mem_001', kind: 'no-show', amountCents: 500 });
    const consolidated = await consolidateBalance(ctx, 'mem_001');
    expect(consolidated!.totalCents).toBe(9500);
    expect(await openInvoicesFor(ctx, 'mem_001')).toHaveLength(1);
    expect((await listFees(ctx, { memberId: 'mem_001' }))[0]!.status).toBe('charged');
  });

  it('lists invoices newest first', async () => {
    await createInvoice(ctx, { lineItems: [{ description: 'a', unitAmountCents: 1, kind: 'membership' }] });
    h.advance(1);
    await createInvoice(ctx, { lineItems: [{ description: 'b', unitAmountCents: 1, kind: 'membership' }] });
    const invoices = await listInvoices(ctx);
    expect(invoices[0]!.lineItems[0]!.description).toBe('b');
  });
});

describe('class packs', () => {
  it('charges the card and grants credits on success', async () => {
    await setupMembers(1);
    const result = await purchasePack(ctx, {
      memberId: 'mem_001',
      packName: '10 Class Pack',
      gateway,
    });
    expect(result.charged).toBe(true);
    expect(result.pack.credits).toBe(10);
    expect(result.pack.creditsRemaining).toBe(10);
    expect(result.amountCents).toBe(15_000);
    expect(gateway.state.payments[0]!.amountCents).toBe(15_000);
  });

  it('does not grant credits when the payment fails', async () => {
    await setupMembers(1);
    gateway.failNext('card_declined');
    const result = await purchasePack(ctx, {
      memberId: 'mem_001',
      packName: '10 Class Pack',
      gateway,
    });
    expect(result.charged).toBe(false);
    expect(await h.repo.table('packs').count()).toBe(0);
  });

  it('records complimentary packs without payment', async () => {
    await setupMembers(1);
    const result = await purchasePack(ctx, {
      memberId: 'mem_001',
      name: 'Welcome pack',
      credits: 3,
      complimentary: true,
    });
    expect(result.pack.creditsRemaining).toBe(3);
    expect(result.pack.priceCents).toBe(0);
  });

  it('expires packs past their date', async () => {
    await setupMembers(1);
    await purchasePack(ctx, {
      memberId: 'mem_001',
      name: 'Old',
      credits: 5,
      complimentary: true,
      expiresInDays: 5,
    });
    h.advance(10);
    expect(await expirePacks(ctx)).toBe(1);
    expect((await h.repo.table('packs').list({ filter: { status: 'expired' } }))[0]!.name).toBe('Old');
  });

  it('reports pack health', async () => {
    await setupMembers(1);
    await purchasePack(ctx, { memberId: 'mem_001', name: 'A', credits: 2, complimentary: true });
    expect((await packHealth(ctx, 'mem_001')).status).toBe('low');
    await purchasePack(ctx, { memberId: 'mem_001', name: 'B', credits: 10, complimentary: true });
    expect((await packHealth(ctx, 'mem_001')).status).toBe('healthy');
  });
});

describe('drop-ins', () => {
  it('sells and books in one step', async () => {
    await setupMembers(2);
    const klass = await seedClass(h, { id: 'cls_1' });
    const result = await purchaseDropIn(ctx, {
      memberId: 'mem_001',
      classId: klass.id,
      gateway,
    });
    expect(result.charged).toBe(true);
    expect(result.bookingId).toBeTruthy();
    expect(result.waitlisted).toBe(false);
    expect(gateway.state.payments[0]!.amountCents).toBe(2200);
  });

  it('waitlists instead of failing when the class is full', async () => {
    await setupMembers(2);
    const klass = await seedClass(h, { id: 'cls_small', capacity: 1 });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: 'mem_001',
      classId: klass.id,
      status: 'booked',
    });
    const result = await purchaseDropIn(ctx, {
      memberId: 'mem_002',
      classId: klass.id,
      gateway,
    });
    expect(result.charged).toBe(true);
    expect(result.waitlisted).toBe(true);
  });
});

describe('fees', () => {
  it('assesses a fee and is idempotent per booking', async () => {
    await setupMembers(1);
    const first = await assessFee(ctx, { memberId: 'mem_001', bookingId: 'bkg_1', kind: 'late-cancel' });
    expect(first.fee.amountCents).toBe(300);
    expect(first.duplicate).toBe(false);

    const second = await assessFee(ctx, { memberId: 'mem_001', bookingId: 'bkg_1', kind: 'late-cancel' });
    expect(second.duplicate).toBe(true);
    expect(await h.repo.table('fees').count()).toBe(1);
  });

  it('charges the card when asked', async () => {
    await setupMembers(1);
    const result = await assessFee(ctx, {
      memberId: 'mem_001',
      kind: 'no-show',
      charge: true,
      gateway,
    });
    expect(result.charged).toBe(true);
    expect((await h.repo.table('fees').findById(result.fee.id))!.status).toBe('charged');
  });

  it('auto-assesses late cancels and no-shows from events', async () => {
    await setupMembers(1, 'fee');
    const handle = connectFees(ctx, gateway);
    const klass = await seedClass(h, { id: 'cls_fee', startTime: h.at(0, 10) });

    await h.repo.table('bookings').insert({
      id: 'bkg_late',
      memberId: 'fee_001',
      classId: klass.id,
      status: 'booked',
      creditsCharged: 1,
    });

    const { cancelBooking, finalizeClass } = await import('@studiodesk/core');
    await cancelBooking(ctx, 'bkg_late');
    expect(await h.repo.table('fees').count({ filter: { kind: 'late-cancel' } })).toBe(1);

    // Put them back on the roster, then close out the class.
    await h.repo.table('bookings').update('bkg_late', { status: 'booked' });
    await finalizeClass(ctx, klass.id);
    expect(await h.repo.table('fees').count({ filter: { kind: 'no-show' } })).toBe(1);

    handle.dispose();
  });

  it('waives fees when the studio cancels the class', async () => {
    await setupMembers(1, 'w');
    const handle = connectFees(ctx, gateway);
    const klass = await seedClass(h, { id: 'cls_cancel' });
    await h.repo.table('fees').insert({
      id: 'fee_1',
      memberId: 'w_001',
      classId: klass.id,
      kind: 'no-show',
      amountCents: 500,
      currency: 'usd',
      status: 'assessed',
      assessedAt: h.now().toISOString(),
    });

    const { cancelClass } = await import('@studiodesk/core');
    await cancelClass(ctx, klass.id, 'instructor sick');
    expect((await h.repo.table('fees').findById('fee_1'))!.status).toBe('waived');
    handle.dispose();
  });
});

describe('memberships and dunning', () => {
  it('subscribes and charges the first period', async () => {
    await setupMembers(1);
    const membership = await subscribe(ctx, {
      memberId: 'mem_001',
      planId: 'plan_unlimited',
      gateway,
    });
    expect(membership.status).toBe('active');
    expect(gateway.state.payments[0]!.amountCents).toBe(8900);
    expect(await listMemberships(ctx, { memberId: 'mem_001' })).toHaveLength(1);
  });

  it('marks the membership past due when the first charge fails', async () => {
    await setupMembers(1);
    gateway.failNext('card_declined');
    const membership = await subscribe(ctx, {
      memberId: 'mem_001',
      planId: 'plan_unlimited',
      gateway,
    });
    expect(membership.status).toBe('past_due');
    // Stage 0 = "payment failed, member notified". The first *retry* is stage 1.
    expect(membership.dunningStage).toBe(0);
    expect(membership.nextDunningAttemptAt).toBe(h.at(1).toISOString());
  });

  it('refuses a second active membership', async () => {
    await setupMembers(1);
    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    await expect(
      subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway }),
    ).rejects.toThrow(/already has an active membership/);
  });

  it('recovers a past-due membership on a successful retry', async () => {
    await setupMembers(1);
    gateway.failNext('card_declined');
    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    const [membership] = await listMemberships(ctx, { memberId: 'mem_001' });

    // The first retry is scheduled for tomorrow - running dunning straight
    // away must not fire it early.
    expect((await runDunning(ctx, gateway)).scanned).toBe(0);

    h.advance(1);
    const result = await runDunning(ctx, gateway);
    expect(result.scanned).toBe(1);
    expect(result.retried).toBe(1);
    expect(result.recovered).toBe(1);

    const after = await h.repo.table('memberships').findById(membership!.id);
    expect(after!.status).toBe('active');
    expect(after!.dunningStage).toBe(0);
  });

  it('escalates through retries, then pauses', async () => {
    await setupMembers(1);
    gateway.failNext('card_declined');
    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });

    // The gateway now succeeds, but the schedule still has to walk through the
    // retry stages to reach the pause at day 7.
    let recoveredAt = -1;
    for (let day = 1; day <= 10; day += 1) {
      h.advance(1);
      if (recoveredAt === -1 && (await runDunning(ctx, gateway)).recovered > 0) {
        recoveredAt = day;
      }
    }

    // The first retry, due one day after the failure, recovers it.
    expect(recoveredAt).toBe(1);

    const [sub] = await listMemberships(ctx, { memberId: 'mem_001' });
    expect(sub!.status).toBe('active');
    expect(sub!.dunningStage).toBe(0);
  });

  it('pauses a membership that never recovers', async () => {
    await setupMembers(1);
    const stubborn = createMockGateway();
    stubborn.failAlways('card_declined');

    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway: stubborn });

    let paused = 0;
    for (let day = 1; day <= 10 && paused === 0; day += 1) {
      h.advance(1);
      paused = (await runDunning(ctx, stubborn)).paused;
    }
    expect(paused).toBe(1);

    const member = await ctx.repo.table('members').findById('mem_001');
    expect(member!.status).toBe('paused');
  });

  it('records successful payments', async () => {
    await setupMembers(1);
    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway, offline: true });
    const [sub] = await listMemberships(ctx, { memberId: 'mem_001' });

    await registerFailedPayment(ctx, { membershipId: sub!.id, amountCents: 8900, failureCode: 'x' });
    expect((await h.repo.table('memberships').findById(sub!.id))!.status).toBe('past_due');

    await registerSuccessfulPayment(ctx, sub!.id, 8900);
    const after = await h.repo.table('memberships').findById(sub!.id);
    expect(after!.status).toBe('active');
    expect(after!.dunningStage).toBe(0);
  });

  it('renews due memberships and rolls the period forward', async () => {
    await setupMembers(1);
    const membership = await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    await h.repo.table('memberships').update(membership.id, {
      currentPeriodEnd: h.at(-1).toISOString(),
    });

    const result = await renewDueMemberships(ctx, gateway);
    expect(result.renewed).toHaveLength(1);
    expect(result.charged).toBe(1);
    const after = await h.repo.table('memberships').findById(membership.id);
    expect(Date.parse(after!.currentPeriodEnd)).toBeGreaterThan(h.now().getTime());
  });

  it('changes plan with proration (downgrade creates a credit)', async () => {
    await setupMembers(1);
    await seedPlan(h, { id: 'plan_basic', name: 'Basic', priceCents: 4000, classCredits: 4 });
    const membership = await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    gateway.reset();

    const result = await changePlan(ctx, {
      membershipId: membership.id,
      newPlanId: 'plan_basic',
      gateway,
    });
    expect(result.membership.planId).toBe('plan_basic');
    expect(gateway.state.payments).toHaveLength(0);
  });

  it('charges the difference on an upgrade', async () => {
    await setupMembers(1);
    await seedPlan(h, { id: 'plan_plus', name: 'Plus', priceCents: 20_000, classCredits: null });
    const membership = await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    gateway.reset();

    await changePlan(ctx, { membershipId: membership.id, newPlanId: 'plan_plus', gateway });
    expect(gateway.state.payments).toHaveLength(1);
    expect(gateway.state.payments[0]!.amountCents).toBeGreaterThan(0);
  });

  it('recovers on demand (the pay-now button)', async () => {
    await setupMembers(1);
    gateway.failNext('card_declined');
    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    const [sub] = await listMemberships(ctx, { memberId: 'mem_001' });
    expect((await recoverNow(ctx, sub!.id, gateway)).recovered).toBe(true);
  });

  it('computes MRR across plans', async () => {
    await setupMembers(2);
    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    await seedPlan(h, { id: 'plan_8', name: '8 Classes', priceCents: 6900, classCredits: 8 });
    await subscribe(ctx, { memberId: 'mem_002', planId: 'plan_8', gateway });
    const revenue = await recurringRevenue(ctx);
    expect(revenue.mrrCents).toBe(8900 + 6900);
    expect(revenue.byPlan).toHaveLength(2);
  });

  it('summarises dunning exposure', async () => {
    await setupMembers(1);
    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    const summary = await dunningSummary(ctx);
    expect(summary.pastDue).toBe(0);
    expect(summary.atRiskRevenueCents).toBe(0);
    expect(Array.isArray(summary.nextActions)).toBe(true);
  });

  it('reports a past-due membership as at-risk revenue', async () => {
    await setupMembers(1);
    gateway.failNext('card_declined');
    await subscribe(ctx, { memberId: 'mem_001', planId: 'plan_unlimited', gateway });
    const summary = await dunningSummary(ctx);
    expect(summary.pastDue).toBe(1);
    expect(summary.atRiskRevenueCents).toBe(8900);
    expect(summary.nextActions).toHaveLength(1);
  });
});

describe('connectBilling', () => {
  it('wires gateways and fee events together', () => {
    const runtime = connectBilling(ctx);
    expect(runtime.gateways).toBeDefined();
    expect(typeof runtime.fees.dispose).toBe('function');
    runtime.fees.dispose();
  });
});