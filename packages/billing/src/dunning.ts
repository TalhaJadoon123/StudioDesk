import {
  AppError,
  addDays,
  daysBetween,
  newEventId,
  sortBy,
  type DunningAction,
  type DunningEvent,
  type DunningPolicy,
  type DunningStep,
  type Membership,
} from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { getStudioSettings, hasFeature } from '@studiodesk/core';
import { createMockGateway, type MockGateway, type PaymentGateway } from './gateway.js';

export function membershipsRepo(ctx: CoreContext) {
  return ctx.repo.table('memberships');
}

export function dunningEventsRepo(ctx: CoreContext) {
  return ctx.repo.table('dunningEvents');
}

export function chargesRepo(ctx: CoreContext) {
  return ctx.repo.table('charges');
}

/** Business-rule violations must map to 4xx, not 500. */
function rule(code: 'conflict' | 'not_found', message: string): Error {
  return new AppError(code, message);
}

export const DEFAULT_DUNNING_POLICY: DunningPolicy = {
  // Day 1: retry. Day 3: retry. Day 5: retry + email. Day 7: pause. Day 21: cancel.
  retryAfterDays: [1, 3, 5],
  emailReceipt: true,
  pauseAfterDays: 7,
  cancelAfterDays: 21,
  feeCents: 0,
};

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

export async function getDunningPolicy(ctx: CoreContext): Promise<DunningPolicy> {
  const settings = await getStudioSettings(ctx);
  const policy: DunningPolicy = {
    retryAfterDays:
      (settings.dunningRetryAfterDays as number[] | undefined) ?? DEFAULT_DUNNING_POLICY.retryAfterDays,
    emailReceipt: DEFAULT_DUNNING_POLICY.emailReceipt,
    pauseAfterDays: (settings.dunningPauseAfterDays as number) ?? DEFAULT_DUNNING_POLICY.pauseAfterDays,
    cancelAfterDays: (settings.dunningCancelAfterDays as number) ?? DEFAULT_DUNNING_POLICY.cancelAfterDays,
    feeCents: DEFAULT_DUNNING_POLICY.feeCents,
  };
  // Smart dunning is a Business feature.
  return (await hasFeature(ctx, 'dunning')) ? policy : { ...policy, retryAfterDays: [] };
}

/** The full escalation schedule for one failed charge. */
export function buildDunningSchedule(
  failedAt: string,
  policy: DunningPolicy,
): DunningStep[] {
  const steps: DunningStep[] = [];
  let stage = 0;

  policy.retryAfterDays.forEach((day, index) => {
    stage += 1;
    steps.push({
      stage,
      dueAt: addDays(failedAt, day).toISOString(),
      action: index === policy.retryAfterDays.length - 1 && policy.emailReceipt ? 'retry_payment' : 'retry_payment',
    });
  });

  if (policy.pauseAfterDays > (policy.retryAfterDays.at(-1) ?? 0)) {
    stage += 1;
    steps.push({
      stage,
      dueAt: addDays(failedAt, policy.pauseAfterDays).toISOString(),
      action: 'pause_membership',
    });
  }

  if (policy.cancelAfterDays > policy.pauseAfterDays) {
    stage += 1;
    steps.push({ stage, dueAt: addDays(failedAt, policy.cancelAfterDays).toISOString(), action: 'cancel_membership' });
  }

  // Always remind the member straight away.
  return [{ stage: 0, dueAt: failedAt, action: 'email_receipt' }, ...steps];
}

export function nextStepFor(steps: DunningStep[], stage: number, now: string): DunningStep | null {
  const upcoming = steps.filter((step) => step.stage > stage).sort((a, b) => a.stage - b.stage);
  return upcoming.find((step) => step.dueAt <= now) ?? null;
}

export function nextActionLabel(action: DunningAction): string {
  switch (action) {
    case 'retry_payment':
      return 'Retrying payment';
    case 'pause_membership':
      return 'Pausing membership';
    case 'cancel_membership':
      return 'Cancelling membership';
    case 'email_receipt':
      return 'Sending payment reminder';
    case 'notify_studio':
      return 'Alerting the studio';
    default:
      return 'No action';
  }
}

/* -------------------------------------------------------------------------- */
/* Failure handling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Marks a charge failed and puts the membership into the dunning state machine.
 * Returns the schedule so the studio can show "3 retries left".
 */
export async function registerFailedPayment(
  ctx: CoreContext,
  input: { membershipId: string; amountCents: number; failureCode?: string; gateway?: string },
): Promise<{ membership: Membership; schedule: DunningStep[]; event: DunningEvent }> {
  const membership = await membershipsRepo(ctx).findById(input.membershipId);
  if (!membership) throw rule('not_found', `Membership ${input.membershipId} not found`);

  const policy = await getDunningPolicy(ctx);
  const at = ctx.now().toISOString();
  const schedule = buildDunningSchedule(at, policy);

  // `dunningStage` is the last stage *attempted*. Stage 0 is the immediate
  // "payment failed" notice, so recording the failure here means the next
  // pending action is stage 1 (the first retry, due in 1 day). Incrementing
  // here would silently skip that first retry.
  const stage = membership.dunningStage ?? 0;
  const nextStage = schedule.find((s) => s.stage === stage + 1);

  await chargesRepo(ctx).insert({
    id: newEventId(),
    studioId: ctx.studioId,
    memberId: membership.memberId,
    amountCents: input.amountCents,
    currency: 'usd',
    status: 'failed',
    gateway: (input.gateway as never) ?? 'manual',
    failureCode: input.failureCode,
    attempt: stage + 1,
    createdAt: at,
    updatedAt: at,
  });

  const updated = await membershipsRepo(ctx).update(input.membershipId, {
    status: 'past_due',
    dunningStage: stage,
    nextDunningAttemptAt: nextStage?.dueAt,
    updatedAt: at,
  });

  const event = await dunningEventsRepo(ctx).insert({
    id: newEventId(),
    membershipId: input.membershipId,
    memberId: membership.memberId,
    stage,
    action: nextStage?.action ?? 'retry_payment',
    attemptedAt: at,
    succeeded: false,
    detail: input.failureCode ?? 'Payment failed',
  });

  await ctx.events.emit('payment.failed', {
    chargeId: event.id,
    memberId: membership.memberId,
    failureCode: input.failureCode,
  });

  return { membership: updated, schedule, event };
}

/** Successful payment clears dunning state. */
export async function registerSuccessfulPayment(
  ctx: CoreContext,
  membershipId: string,
  amountCents: number,
  gateway = 'manual',
): Promise<Membership> {
  const membership = await membershipsRepo(ctx).findById(membershipId);
  if (!membership) throw rule('not_found', `Membership ${membershipId} not found`);
  const at = ctx.now().toISOString();

  await chargesRepo(ctx).insert({
    id: newEventId(),
    studioId: ctx.studioId,
    memberId: membership.memberId,
    amountCents,
    currency: 'usd',
    status: 'succeeded',
    gateway: gateway as never,
    attempt: (membership.dunningStage ?? 0) + 1,
    createdAt: at,
    updatedAt: at,
  });

  return membershipsRepo(ctx).update(membershipId, {
    status: 'active',
    dunningStage: 0,
    nextDunningAttemptAt: undefined,
    lastPaymentAt: at,
    updatedAt: at,
  });
}

/* -------------------------------------------------------------------------- */
/* The runner                                                                 */
/* -------------------------------------------------------------------------- */

export interface DunningRunResult {
  scanned: number;
  retried: number;
  recovered: number;
  paused: number;
  cancelled: number;
  reminded: number;
  events: DunningEvent[];
  details: Array<{ memberId: string; action: DunningAction; outcome: string }>;
}

/**
 * Runs the dunning state machine over every past-due membership.
 *
 * Called by a cron/Workers scheduled task (`POST /api/dunning/run`) or by hand
 * from the billing page. Idempotent: a membership already advanced past a step
 * is skipped.
 */
export async function runDunning(
  ctx: CoreContext,
  gateway?: PaymentGateway,
  options: { limit?: number; now?: Date } = {},
): Promise<DunningRunResult> {
  const now = options.now ?? ctx.now();
  const nowIso = now.toISOString();
  const policy = await getDunningPolicy(ctx);
  const result: DunningRunResult = {
    scanned: 0,
    retried: 0,
    recovered: 0,
    paused: 0,
    cancelled: 0,
    reminded: 0,
    events: [],
    details: [],
  };

  // A membership is in play if it is past due, or was paused by dunning and is
  // still inside its grace period (which is how it reaches the cancel stage).
  const all = await membershipsRepo(ctx).list();
  const dunningPaused = new Set(
    (
      await dunningEventsRepo(ctx).list({
        filter: { action: 'pause_membership', succeeded: true },
      })
    ).map((event) => event.membershipId),
  );

  const pastDue = all
    .filter(
      (membership) =>
        (membership.status === 'past_due' || dunningPaused.has(membership.id)) &&
        (!membership.nextDunningAttemptAt || membership.nextDunningAttemptAt <= nowIso),
    )
    .slice(0, options.limit ?? 200);

  const gatewayToUse = gateway ?? createMockGateway();

  for (const membership of pastDue) {
    result.scanned += 1;
    const member = await ctx.repo.table('members').findById(membership.memberId);
    const plan = await ctx.repo.table('plans').findById(membership.planId);
    const amount = plan?.priceCents ?? 0;
    const stage = membership.dunningStage ?? 0;
    // The schedule must be anchored to when the payment actually failed, not
    // to the period end - otherwise every step lands a month in the future and
    // dunning never fires.
    const anchor = await firstFailureAt(ctx, membership.id) ?? membership.currentPeriodEnd;
    const schedule = buildDunningSchedule(anchor, policy);
    const step = nextStepFor(schedule, stage, nowIso);

    if (!step) {
      result.details.push({ memberId: membership.memberId, action: 'none', outcome: 'nothing due' });
      continue;
    }

    if (step.action === 'retry_payment' && amount > 0) {
      result.retried += 1;
      const payment = await gatewayToUse.createPayment({
        amountCents: amount,
        currency: 'usd',
        description: `Membership retry - ${member?.name ?? membership.memberId}`,
        memberId: membership.memberId,
        idempotencyKey: `sd_dunning_${membership.id}_${step.stage}`,
        metadata: { memberId: membership.memberId, membershipId: membership.id, stage: String(step.stage) },
      });

      if (payment.status === 'succeeded') {
        const recovered = await recover(ctx, membership.id, amount, gatewayToUse.name, step.stage);
        result.recovered += 1;
        result.events.push(recovered);
        result.details.push({
          memberId: membership.memberId,
          action: 'retry_payment',
          outcome: `recovered ${amount} cents`,
        });
        continue;
      }

      // Still failing: advance to the next stage and wait for it to come due.
      const upcoming = schedule.find((s) => s.stage === step.stage + 1);
      await membershipsRepo(ctx).update(membership.id, {
        dunningStage: step.stage,
        nextDunningAttemptAt: upcoming?.dueAt,
        updatedAt: nowIso,
      });
      result.events.push(
        await dunningEventsRepo(ctx).insert({
          id: newEventId(),
          membershipId: membership.id,
          memberId: membership.memberId,
          stage: step.stage,
          action: 'retry_payment',
          attemptedAt: nowIso,
          succeeded: false,
          detail: payment.failureCode ?? 'Retry failed',
        }),
      );
      result.details.push({
        memberId: membership.memberId,
        action: 'retry_payment',
        outcome: `failed again: ${payment.failureCode ?? 'unknown'}`,
      });
      continue;
    }

    if (step.action === 'pause_membership') {
      result.paused += 1;
      await membershipsRepo(ctx).update(membership.id, { dunningStage: step.stage });
      const paused = await pauseAfterFailure(ctx, membership);
      result.events.push(paused);
      result.details.push({ memberId: membership.memberId, action: 'pause_membership', outcome: 'paused' });
      continue;
    }

    if (step.action === 'cancel_membership') {
      result.cancelled += 1;
      const cancelled = await cancelAfterFailure(ctx, membership);
      result.events.push(cancelled);
      result.details.push({
        memberId: membership.memberId,
        action: 'cancel_membership',
        outcome: 'cancelled',
      });
      continue;
    }

    if (step.action === 'email_receipt') {
      result.reminded += 1;
      result.details.push({ memberId: membership.memberId, action: 'email_receipt', outcome: 'reminder queued' });
    }
  }

  return result;
}

/** Timestamp of the first failed dunning attempt for a membership. */
async function firstFailureAt(ctx: CoreContext, membershipId: string): Promise<string | null> {
  const events = await dunningEventsRepo(ctx).list({
    filter: { membershipId, succeeded: false },
  });
  const first = sortBy(events, (e) => e.attemptedAt, 'asc')[0];
  return first?.attemptedAt ?? null;
}

async function recover(
  ctx: CoreContext,
  membershipId: string,
  amountCents: number,
  gateway: string,
  stage: number,
): Promise<DunningEvent> {
  await registerSuccessfulPayment(ctx, membershipId, amountCents, gateway);
  const { resumeMember } = await import('@studiodesk/core');
  const membership = await membershipsRepo(ctx).findById(membershipId);
  if (membership) await resumeMember(ctx, membership.memberId).catch(() => undefined);

  return dunningEventsRepo(ctx).insert({
    id: newEventId(),
    membershipId,
    memberId: membership?.memberId ?? 'unknown',
    stage,
    action: 'retry_payment',
    attemptedAt: ctx.now().toISOString(),
    succeeded: true,
    detail: `Recovered ${amountCents} cents`,
  });
}

async function pauseAfterFailure(ctx: CoreContext, membership: Membership): Promise<DunningEvent> {
  const { pauseMember } = await import('@studiodesk/core');
  await pauseMember(ctx, membership.memberId, 30).catch(() => undefined);

  // The membership stays past_due (not `paused`) so the cancellation stage
  // later on still fires; `pausedUntil` records the member-facing pause.
  const until = addDays(ctx.now(), 30).toISOString().slice(0, 10);
  await membershipsRepo(ctx).update(membership.id, {
    pausedUntil: until,
    // The final stage is due 14 days after the pause.
    nextDunningAttemptAt: addDays(ctx.now(), 14).toISOString(),
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.repo
    .table('members')
    .update(membership.memberId, { status: 'paused', pausedUntil: until });

  await ctx.events.emit('membership.paused', {
    membershipId: membership.id,
    memberId: membership.memberId,
  });
  return dunningEventsRepo(ctx).insert({
    id: newEventId(),
    membershipId: membership.id,
    memberId: membership.memberId,
    stage: (membership.dunningStage ?? 0) + 1,
    action: 'pause_membership',
    attemptedAt: ctx.now().toISOString(),
    succeeded: true,
    detail: 'Paused for 30 days after failed payments',
  });
}

async function cancelAfterFailure(ctx: CoreContext, membership: Membership): Promise<DunningEvent> {
  const { cancelMember } = await import('@studiodesk/core');
  await cancelMember(ctx, membership.memberId, 'Unpaid - cancelled by dunning').catch(() => undefined);
  await membershipsRepo(ctx).update(membership.id, {
    status: 'cancelled',
    cancelledAt: ctx.now().toISOString(),
    nextDunningAttemptAt: undefined,
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.events.emit('membership.cancelled', {
    membershipId: membership.id,
    memberId: membership.memberId,
  });
  return dunningEventsRepo(ctx).insert({
    id: newEventId(),
    membershipId: membership.id,
    memberId: membership.memberId,
    stage: (membership.dunningStage ?? 0) + 1,
    action: 'cancel_membership',
    attemptedAt: ctx.now().toISOString(),
    succeeded: true,
    detail: 'Cancelled after 21 days of failed payments',
  });
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

export interface DunningSummary {
  pastDue: number;
  paused: number;
  activeMemberships: number;
  atRiskRevenueCents: number;
  recoveringThisMonth: number;
  recoveredCents: number;
  averageDaysToRecover: number;
  nextActions: Array<{ membershipId: string; memberId: string; memberName?: string; dueAt: string; stage: number }>;
}

export async function dunningSummary(ctx: CoreContext): Promise<DunningSummary> {
  const [memberships, events, members] = await Promise.all([
    membershipsRepo(ctx).list(),
    dunningEventsRepo(ctx).list(),
    ctx.repo.table('members').list(),
  ]);
  const planIds = new Set(memberships.map((m) => m.planId));
  const plans = await Promise.all([...planIds].map((id) => ctx.repo.table('plans').findById(id)));
  const priceByPlan = new Map(plans.filter(Boolean).map((p) => [p!.id, p!.priceCents] as const));
  const memberName = new Map(members.map((m) => [m.id, m.name] as const));

  const pastDue = memberships.filter((m) => m.status === 'past_due');
  const recoveries = events.filter((e) => e.succeeded && e.action === 'retry_payment');
  const monthAgo = addDays(ctx.now(), -30).toISOString();
  const recoveringThisMonth = events.filter((e) => e.attemptedAt >= monthAgo).length;
  const recovered = recoveries.filter((e) => e.attemptedAt >= monthAgo);

  const totalRecoveredCents = recovered.reduce((acc, event) => {
    const cents = Number(event.detail?.match(/\d+/)?.[0] ?? 0);
    return acc + cents;
  }, 0);

  const averageDaysToRecover = recovered.length
    ? Number(
        (
          recovered.reduce((acc, event) => {
            const failure = sortBy(
              events.filter((e) => e.membershipId === event.membershipId && !e.succeeded),
              (e) => e.attemptedAt,
              'desc',
            )[0];
            return acc + (failure ? Math.max(0, daysBetween(failure.attemptedAt, event.attemptedAt)) : 0);
          }, 0) / recovered.length
        ).toFixed(1),
      )
    : 0;

  return {
    pastDue: pastDue.length,
    paused: memberships.filter((m) => m.status === 'paused').length,
    activeMemberships: memberships.filter((m) => m.status === 'active').length,
    atRiskRevenueCents: pastDue.reduce((acc, m) => acc + (priceByPlan.get(m.planId) ?? 0), 0),
    recoveringThisMonth,
    recoveredCents: totalRecoveredCents,
    averageDaysToRecover,
    nextActions: sortBy(
      memberships
        .filter((m) => m.status === 'past_due' && m.nextDunningAttemptAt)
        .map((m) => ({
          membershipId: m.id,
          memberId: m.memberId,
          memberName: memberName.get(m.memberId),
          dueAt: m.nextDunningAttemptAt!,
          stage: m.dunningStage ?? 0,
        })),
      (row) => row.dueAt,
      'asc',
    ).slice(0, 10),
  };
}

export async function listDunningEvents(
  ctx: CoreContext,
  query: { membershipId?: string; memberId?: string; limit?: number } = {},
): Promise<DunningEvent[]> {
  const filter: Record<string, unknown> = {};
  if (query.membershipId) filter.membershipId = query.membershipId;
  if (query.memberId) filter.memberId = query.memberId;
  const rows = await dunningEventsRepo(ctx).list({ filter: filter as never });
  const sorted = sortBy(rows, (e) => e.attemptedAt, 'desc');
  return query.limit ? sorted.slice(0, query.limit) : sorted;
}

/** Lets a member pay and clears dunning immediately (the "pay now" button). */
export async function recoverNow(
  ctx: CoreContext,
  membershipId: string,
  gateway: PaymentGateway,
): Promise<{ recovered: boolean; amountCents: number; failureCode?: string }> {
  const membership = await membershipsRepo(ctx).findById(membershipId);
  if (!membership) throw rule('not_found', `Membership ${membershipId} not found`);
  const plan = await ctx.repo.table('plans').findById(membership.planId);
  const amount = plan?.priceCents ?? 0;
  const member = await ctx.repo.table('members').findById(membership.memberId);

  const payment = await gateway.createPayment({
    amountCents: amount,
    currency: 'usd',
    description: `Membership recovery - ${member?.name ?? membership.memberId}`,
    memberId: membership.memberId,
    idempotencyKey: `sd_recover_${membership.id}`,
    metadata: { memberId: membership.memberId, membershipId: membership.id },
  });

  if (payment.status !== 'succeeded') {
    await dunningEventsRepo(ctx).insert({
      id: newEventId(),
      membershipId,
      memberId: membership.memberId,
      stage: (membership.dunningStage ?? 0) + 1,
      action: 'retry_payment',
      attemptedAt: ctx.now().toISOString(),
      succeeded: false,
      detail: payment.failureCode ?? 'Member-initiated retry failed',
    });
    return { recovered: false, amountCents: amount, failureCode: payment.failureCode };
  }

  await recover(ctx, membershipId, amount, gateway.name, (membership.dunningStage ?? 0) + 1);
  return { recovered: true, amountCents: amount };
}

export type { MockGateway };