import { AppError, addDays, addMonths, sortBy, type Membership, type Plan } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { createInvoice, markPaid } from './invoices.js';
import { registerFailedPayment, registerSuccessfulPayment, membershipsRepo } from './dunning.js';
import { chargeKey } from './stripe.js';
import { createManualGateway, type PaymentGateway } from './gateway.js';

export { membershipsRepo };

/**
 * Business-rule violations must be `AppError`s, not plain `Error`s: the API
 * maps `conflict` to 409 and `not_found` to 404, and anything unrecognised
 * becomes a 500. A duplicate subscription is the caller's problem, not a
 * server fault, so it must not look like a crash.
 */
function rule(code: 'conflict' | 'not_found' | 'payment_failed', message: string): Error {
  return new AppError(code, message);
}

export interface SubscribeInput {
  memberId: string;
  planId: string;
  gateway?: PaymentGateway;
  /** Charge the first period now (default true). */
  chargeNow?: boolean;
  trialDays?: number;
  /** Free / manual mode: no gateway call, just an internal record. */
  offline?: boolean;
  cancelUrl?: string;
}

/**
 * Starts a recurring membership.
 *
 * Creates the internal `Membership` record first so dunning always has
 * something to point at, then asks the gateway to subscribe. If the gateway
 * call fails the membership is marked past-due rather than silently dropped.
 */
export async function subscribe(ctx: CoreContext, input: SubscribeInput): Promise<Membership> {
  const [member, plan] = await Promise.all([
    ctx.repo.table('members').findById(input.memberId),
    ctx.repo.table('plans').findById(input.planId),
  ]);
  if (!member) throw rule('not_found', `Member ${input.memberId} not found`);
  if (!plan) throw rule('not_found', `Plan ${input.planId} not found`);
  if (!plan.active) throw rule('conflict', `Plan ${plan.name} is not active`);

  const gateway = input.gateway ?? (input.offline ? createManualGateway() : undefined);
  const at = ctx.now();
  const periodStart = at.toISOString();
  const periodEnd =
    plan.interval === 'year' ? addMonths(at, 12).toISOString() : addMonths(at, 1).toISOString();

  const existing = await membershipsRepo(ctx).findOne({
                                               filter: {
    memberId: member.id,
    status: { $in: ['active', 'trialing', 'past_due', 'paused'] },
  
                                             },
                                             } as never);
  if (existing) throw rule('conflict', `${member.name} already has an active membership`);

  let customerId: string | undefined;
  let gatewaySubscriptionId: string | undefined;
  let status: Membership['status'] = 'active';

  if (gateway && !input.offline) {
    const customer = await gateway.createCustomer({
      memberId: member.id,
      email: member.email,
      name: member.name,
      metadata: { studioId: ctx.studioId ?? 'default' },
    });
    customerId = customer.id;

    const subscription = await gateway.createSubscription({
      customerId: customer.id,
      memberId: member.id,
      productId: plan.gatewayProductId ?? plan.id,
      amountCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      trialDays: input.trialDays,
      metadata: { memberId: member.id, planId: plan.id },
    });
    gatewaySubscriptionId = subscription.id;
    status = subscription.status === 'trialing' ? 'trialing' : 'active';
  }

  const membership: Membership = {
    id: `mbs_${member.id}_${Date.now().toString(36)}`,
    studioId: ctx.studioId,
    memberId: member.id,
    planId: plan.id,
    status,
    gateway: gateway?.name ?? 'manual',
    gatewayCustomerId: customerId,
    gatewaySubscriptionId,
    startedAt: periodStart,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    dunningStage: 0,
    lastPaymentAt: input.chargeNow === false ? undefined : input.offline ? periodStart : undefined,
    createdAt: periodStart,
    updatedAt: periodStart,
  };

  const created = await membershipsRepo(ctx).insert(membership);
  await ctx.repo.table('members').update(member.id, {
    planId: plan.id,
    monthlyPriceCents: plan.priceCents,
    currency: plan.currency,
    status: 'active',
    updatedAt: periodStart,
  });

  if (input.chargeNow !== false && plan.priceCents > 0 && !input.offline && gateway) {
    return chargePeriod(ctx, created, plan, gateway);
  }
  if (input.chargeNow !== false && plan.priceCents > 0 && input.offline) {
    await recordOfflinePayment(ctx, created, plan);
  }

  await ctx.events.emit('membership.started', {
    membershipId: created.id,
    memberId: member.id,
    planId: plan.id,
  });
  return created;
}

/** Charges the current period and reconciles the invoice + charge record. */
async function chargePeriod(
  ctx: CoreContext,
  membership: Membership,
  plan: Plan,
  gateway: PaymentGateway,
): Promise<Membership> {
  const invoice = await createInvoice(ctx, {
    memberId: membership.memberId,
    currency: plan.currency,
    lineItems: [
      {
        description: `${plan.name} (${plan.interval === 'year' ? 'annual' : 'monthly'})`,
        quantity: 1,
        unitAmountCents: plan.priceCents,
        kind: 'membership',
        metadata: { membershipId: membership.id, planId: plan.id },
      },
    ],
  });

  const payment = await gateway.createPayment({
    amountCents: plan.priceCents,
    currency: plan.currency,
    description: plan.name,
    customerId: membership.gatewayCustomerId,
    memberId: membership.memberId,
    idempotencyKey: chargeKey('membership', membership.memberId, `${membership.id}_${invoice.id}`),
    metadata: { memberId: membership.memberId, membershipId: membership.id, invoiceId: invoice.id },
  });

  if (payment.status !== 'succeeded') {
    const { membership: pastDue } = await registerFailedPayment(ctx, {
      membershipId: membership.id,
      amountCents: plan.priceCents,
      failureCode: payment.failureCode,
      gateway: gateway.name,
    });
    return pastDue;
  }

  await markPaid(ctx, invoice.id, plan.priceCents);
  return registerSuccessfulPayment(ctx, membership.id, plan.priceCents, gateway.name);
}

async function recordOfflinePayment(
  ctx: CoreContext,
  membership: Membership,
  plan: Plan,
): Promise<void> {
  const invoice = await createInvoice(ctx, {
    memberId: membership.memberId,
    currency: plan.currency,
    lineItems: [
      {
        description: `${plan.name} (paid at the desk)`,
        quantity: 1,
        unitAmountCents: plan.priceCents,
        kind: 'membership',
      },
    ],
  });
  await markPaid(ctx, invoice.id, plan.priceCents);
  await registerSuccessfulPayment(ctx, membership.id, plan.priceCents, 'manual');
}

/* -------------------------------------------------------------------------- */
/* Changes                                                                    */
/* -------------------------------------------------------------------------- */

export interface ChangePlanResult {
  membership: Membership;
  prorationCents: number;
  invoiceId?: string;
}

/**
 * Switches plan mid-cycle, charging or crediting the difference.
 *
 * Proration is calculated on the remaining days in the current period, which is
 * what booking tools do and what members expect.
 */
export async function changePlan(
  ctx: CoreContext,
  input: { membershipId: string; newPlanId: string; gateway?: PaymentGateway; proration?: boolean },
): Promise<ChangePlanResult> {
  const [membership, newPlan] = await Promise.all([
    membershipsRepo(ctx).findById(input.membershipId),
    ctx.repo.table('plans').findById(input.newPlanId),
  ]);
  if (!membership) throw rule('not_found', `Membership ${input.membershipId} not found`);
  if (!newPlan) throw rule('not_found', `Plan ${input.newPlanId} not found`);

  const currentPlan = await ctx.repo.table('plans').findById(membership.planId);
  const at = ctx.now();
  const periodEnd = Date.parse(membership.currentPeriodEnd);
  const remaining = Math.max(0, periodEnd - at.getTime());
  const totalPeriod = Math.max(1, periodEnd - Date.parse(membership.currentPeriodStart));

  const oldValue = currentPlan?.priceCents ?? 0;
  const newValue = newPlan.priceCents;
  const unusedCredit = Math.round((oldValue * remaining) / totalPeriod);
  const charge = Math.max(0, newValue - unusedCredit);
  const credit = Math.max(0, unusedCredit - newValue);

  const gateway = input.gateway;
  let invoiceId: string | undefined;

  // Upgrades charge the difference immediately; downgrades create a credit.
  if (input.proration !== false && charge > 0) {
    const invoice = await createInvoice(ctx, {
      memberId: membership.memberId,
      currency: newPlan.currency,
      lineItems: [
        {
          description: `Plan change to ${newPlan.name} (prorated)`,
          quantity: 1,
          unitAmountCents: charge,
          kind: 'proration',
          metadata: { from: membership.planId, to: newPlan.id },
        },
      ],
    });
    invoiceId = invoice.id;
    if (gateway) {
      const payment = await gateway.createPayment({
        amountCents: charge,
        currency: newPlan.currency,
        description: `Upgrade to ${newPlan.name}`,
        customerId: membership.gatewayCustomerId,
        memberId: membership.memberId,
        idempotencyKey: chargeKey('membership', membership.memberId, `upgrade_${invoice.id}`),
        metadata: { memberId: membership.memberId, invoiceId: invoice.id },
      });
      if (payment.status === 'succeeded') await markPaid(ctx, invoice.id, charge);
      else {
        await registerFailedPayment(ctx, {
          membershipId: membership.id,
          amountCents: charge,
          failureCode: payment.failureCode,
          gateway: gateway.name,
        });
      }
    } else {
      await markPaid(ctx, invoice.id, charge);
    }
  }

  if (credit > 0) {
    const invoice = await createInvoice(ctx, {
      memberId: membership.memberId,
      currency: newPlan.currency,
      lineItems: [
        {
          description: `Credit from unused time on ${currentPlan?.name ?? 'your plan'}`,
          quantity: 1,
          unitAmountCents: -credit,
          kind: 'discount',
        },
      ],
    });
    invoiceId = invoice.id;
    await markPaid(ctx, invoice.id, 0);
  }

  const updated = await membershipsRepo(ctx).update(membership.id, {
    planId: newPlan.id,
    updatedAt: at.toISOString(),
  });

  await ctx.repo.table('members').update(membership.memberId, {
    planId: newPlan.id,
    monthlyPriceCents: newPlan.priceCents,
    currency: newPlan.currency,
    updatedAt: at.toISOString(),
  });

  return { membership: updated, prorationCents: charge, invoiceId };
}

export async function cancelMembership(
  ctx: CoreContext,
  membershipId: string,
  options: { immediate?: boolean; gateway?: PaymentGateway; reason?: string } = {},
): Promise<Membership> {
  const membership = await membershipsRepo(ctx).findById(membershipId);
  if (!membership) throw rule('not_found', `Membership ${membershipId} not found`);

  const at = ctx.now().toISOString();
  const cancelAtPeriodEnd = !options.immediate;

  if (options.gateway && membership.gatewaySubscriptionId && options.immediate) {
    await options.gateway.cancelSubscription(membership.gatewaySubscriptionId, true).catch(() => undefined);
  }

  const updated = await membershipsRepo(ctx).update(membershipId, {
    status: cancelAtPeriodEnd ? 'active' : 'cancelled',
    cancelAtPeriodEnd,
    cancelledAt: cancelAtPeriodEnd ? undefined : at,
    nextDunningAttemptAt: undefined,
    updatedAt: at,
  });

  if (!cancelAtPeriodEnd) {
    await ctx.repo.table('members').update(membership.memberId, {
      status: 'cancelled',
      cancelledAt: at,
      updatedAt: at,
    });
  }

  await ctx.events.emit('membership.cancelled', {
    membershipId,
    memberId: membership.memberId,
  });
  return updated;
}

/** Freezes billing (holiday mode). Reservations keep working. */
export async function pauseMembership(
  ctx: CoreContext,
  membershipId: string,
  days = 30,
): Promise<Membership> {
  const membership = await membershipsRepo(ctx).findById(membershipId);
  if (!membership) throw rule('not_found', `Membership ${membershipId} not found`);
  const at = ctx.now();
  const updated = await membershipsRepo(ctx).update(membershipId, {
    status: 'paused',
    pausedUntil: addDays(at, days).toISOString().slice(0, 10),
    currentPeriodEnd: addDays(membership.currentPeriodEnd, days).toISOString(),
    updatedAt: at.toISOString(),
  });
  await ctx.repo.table('members').update(membership.memberId, {
    status: 'paused',
    pausedUntil: updated.pausedUntil,
    updatedAt: at.toISOString(),
  });
  return updated;
}

export async function resumeMembership(ctx: CoreContext, membershipId: string): Promise<Membership> {
  const membership = await membershipsRepo(ctx).findById(membershipId);
  if (!membership) throw rule('not_found', `Membership ${membershipId} not found`);
  const updated = await membershipsRepo(ctx).update(membershipId, {
    status: 'active',
    pausedUntil: undefined,
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.repo.table('members').update(membership.memberId, {
    status: 'active',
    pausedUntil: undefined,
    updatedAt: ctx.now().toISOString(),
  });
  return updated;
}

/* -------------------------------------------------------------------------- */
/* Renewal                                                                    */
/* -------------------------------------------------------------------------- */

export interface RenewResult {
  renewed: Membership[];
  charged: number;
  failed: number;
  totalCents: number;
}

/**
 * Renews every membership whose period ended. Call daily from a cron or a
 * Cloudflare Worker scheduled task.
 */
export async function renewDueMemberships(
  ctx: CoreContext,
  gateway?: PaymentGateway,
  options: { now?: Date; limit?: number } = {},
): Promise<RenewResult> {
  const now = options.now ?? ctx.now();
  const due = (
    await membershipsRepo(ctx).list({ filter: { status: { $in: ['active', 'trialing'] } } })
  )
    .filter((membership) => Date.parse(membership.currentPeriodEnd) <= now.getTime())
    .slice(0, options.limit ?? 200);

  const result: RenewResult = { renewed: [], charged: 0, failed: 0, totalCents: 0 };

  for (const membership of due) {
    const plan = await ctx.repo.table('plans').findById(membership.planId);
    if (!plan || !plan.active) {
      await membershipsRepo(ctx).update(membership.id, {
        status: 'cancelled',
        cancelledAt: now.toISOString(),
      });
      continue;
    }

    const periodStart = now.toISOString();
    const periodEnd =
      plan.interval === 'year' ? addMonths(now, 12).toISOString() : addMonths(now, 1).toISOString();

    await membershipsRepo(ctx).update(membership.id, {
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      updatedAt: periodStart,
    });

    if (plan.priceCents > 0) {
      const refreshed = await membershipsRepo(ctx).findById(membership.id);
      if (!refreshed) continue;
      const after = gateway ? await chargePeriod(ctx, refreshed, plan, gateway) : refreshed;
      if (after.status === 'past_due') result.failed += 1;
      else {
        result.charged += 1;
        result.totalCents += plan.priceCents;
      }
    }
    result.renewed.push(membership);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export async function getMembership(ctx: CoreContext, id: string): Promise<Membership | null> {
  return membershipsRepo(ctx).findById(id);
}

export async function findActiveMembership(
  ctx: CoreContext,
  memberId: string,
): Promise<Membership | null> {
  return membershipsRepo(ctx).findOne({ filter: { memberId, status: 'active' } });
}

export async function listMemberships(
  ctx: CoreContext,
  query: { memberId?: string; status?: Membership['status'] } = {},
): Promise<Membership[]> {
  const filter: Record<string, unknown> = {};
  if (query.memberId) filter.memberId = query.memberId;
  if (query.status) filter.status = query.status;
  return membershipsRepo(ctx).list({ filter: filter as never });
}

/** Recurring revenue, split by plan. Powers the billing page and the MRR tile. */
export async function recurringRevenue(ctx: CoreContext) {
  const [memberships, plans] = await Promise.all([
    membershipsRepo(ctx).list({ filter: { status: 'active' } }),
    ctx.repo.table('plans').list(),
  ]);
  const byPlan = new Map<string, { members: number; mrrCents: number }>();
  for (const membership of memberships) {
    const plan = plans.find((p) => p.id === membership.planId);
    const row = byPlan.get(membership.planId) ?? { members: 0, mrrCents: 0 };
    row.members += 1;
    // Annual plans contribute their monthly equivalent to MRR.
    row.mrrCents += plan
      ? plan.interval === 'year'
        ? Math.round(plan.priceCents / 12)
        : plan.priceCents
      : 0;
    byPlan.set(membership.planId, row);
  }
  return {
    mrrCents: [...byPlan.values()].reduce((acc, row) => acc + row.mrrCents, 0),
    activeMemberships: memberships.length,
    byPlan: sortBy(
      [...byPlan.entries()].map(([planId, row]) => {
        const plan = plans.find((p) => p.id === planId);
        return { planId, name: plan?.name ?? planId, ...row };
      }),
      (row) => row.mrrCents,
      'desc',
    ),
  };
}

/** Renewals due in the next N days - the "upcoming bills" widget. */
export async function upcomingRenewals(ctx: CoreContext, days = 14) {
  const horizon = addDays(ctx.now(), days).toISOString();
  const [memberships, plans, members] = await Promise.all([
    membershipsRepo(ctx).list({ filter: { status: 'active' } }),
    ctx.repo.table('plans').list(),
    ctx.repo.table('members').list(),
  ]);
  const memberName = new Map(members.map((m) => [m.id, m.name] as const));
  return sortBy(
    memberships
      .filter((membership) => membership.currentPeriodEnd <= horizon)
      .map((membership) => {
        const plan = plans.find((p) => p.id === membership.planId);
        return {
          membershipId: membership.id,
          memberId: membership.memberId,
          memberName: memberName.get(membership.memberId),
          planName: plan?.name ?? membership.planId,
          amountCents: plan?.priceCents ?? 0,
          renewsAt: membership.currentPeriodEnd,
          daysUntil: Math.ceil(
            (Date.parse(membership.currentPeriodEnd) - ctx.now().getTime()) / 86_400_000,
          ),
        };
      }),
    (row) => row.renewsAt,
    'asc',
  );
}