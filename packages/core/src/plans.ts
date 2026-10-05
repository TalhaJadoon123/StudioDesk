import {
  DEFAULT_CURRENCY,
  notFound,
  newMemberId,
  sortBy,
  toCents,
  type Currency,
  type Member,
  type Plan,
  type PlanTier,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { getStudio } from './studio.js';

export function plansRepo(ctx: CoreContext) {
  return ctx.repo.table('plans');
}

/** Sensible starting plans for a new studio, derived from its tier. */
export const DEFAULT_MEMBER_PLANS = [
  {
    name: 'Unlimited Monthly',
    priceCents: 0,
    classCredits: null,
    description: 'Unlimited classes, billed monthly.',
  },
  {
    name: '8 Classes / month',
    priceCents: 0,
    classCredits: 8,
    description: 'Eight class credits a month.',
  },
  {
    name: 'Drop-in',
    priceCents: 0,
    classCredits: 1,
    description: 'Single class, no commitment.',
  },
] as const;

export async function createPlan(
  ctx: CoreContext,
  input: {
    name: string;
    priceCents: number;
    currency?: Currency;
    interval?: 'month' | 'year';
    classCredits?: number | null;
    description?: string;
    gatewayProductId?: string;
    active?: boolean;
    tier?: PlanTier;
  },
): Promise<Plan> {
  const studio = await getStudio(ctx);
  const at = ctx.now().toISOString();
  const plan: Plan = {
    // Tiered platform plans get a stable `tier_*` id so the UI can reference them.
    id: input.tier ? `tier_${input.tier}` : `plan_${newMemberId().slice(4, 14)}`,
    studioId: studio.id,
    name: input.name,
    tier: input.tier ?? 'starter',
    priceCents: input.priceCents,
    currency: input.currency ?? studio.currency ?? DEFAULT_CURRENCY,
    interval: input.interval ?? 'month',
    classCredits: input.classCredits ?? null,
    description: input.description,
    gatewayProductId: input.gatewayProductId,
    active: input.active ?? true,
    createdAt: at,
    updatedAt: at,
  };
  return plansRepo(ctx).insert(plan);
}

export async function updatePlan(ctx: CoreContext, id: string, patch: Partial<Plan>): Promise<Plan> {
  await requirePlan(ctx, id);
  return plansRepo(ctx).update(id, { ...patch, updatedAt: ctx.now().toISOString() });
}

export async function getPlan(ctx: CoreContext, id: string): Promise<Plan | null> {
  return plansRepo(ctx).findById(id);
}

export async function requirePlan(ctx: CoreContext, id: string): Promise<Plan> {
  const plan = await getPlan(ctx, id);
  if (!plan) throw notFound('Plan', id);
  return plan;
}

export async function deletePlan(ctx: CoreContext, id: string): Promise<boolean> {
  await requirePlan(ctx, id);
  const inUse = await ctx.repo.table('members').count({ filter: { planId: id } });
  if (inUse > 0) {
    const err = new Error(`Plan ${id} is used by ${inUse} member(s)`);
    (err as Error & { code: string }).code = 'conflict';
    throw err;
  }
  return plansRepo(ctx).remove(id);
}

export async function listPlans(ctx: CoreContext, options: { activeOnly?: boolean } = {}): Promise<Plan[]> {
  const rows = await plansRepo(ctx).list();
  const studio = await getStudio(ctx);
  const scoped = rows.filter((plan) => !plan.studioId || plan.studioId === studio.id);
  const filtered = options.activeOnly ? scoped.filter((p) => p.active) : scoped;
  return sortBy(filtered, (p) => p.priceCents, 'asc');
}

/** Convenience for POST /plans with a dollar-denominated body. */
export async function createPlanFromDollars(
  ctx: CoreContext,
  input: { name: string; price: number | string; currency?: Currency; classCredits?: number | null; description?: string },
): Promise<Plan> {
  return createPlan(ctx, { ...input, priceCents: toCents(input.price) });
}

/* -------------------------------------------------------------------------- */
/* Membership assignment                                                      */
/* -------------------------------------------------------------------------- */

export async function assignPlan(
  ctx: CoreContext,
  memberId: string,
  planId: string,
): Promise<Member> {
  const [member, plan] = await Promise.all([
    ctx.repo.table('members').findById(memberId),
    requirePlan(ctx, planId),
  ]);
  if (!member) throw notFound('Member', memberId);
  const updated = await ctx.repo.table('members').update(memberId, {
    planId: plan.id,
    monthlyPriceCents: plan.priceCents,
    currency: plan.currency,
    updatedAt: ctx.now().toISOString(),
  });
  return updated;
}

export async function membersOnPlan(ctx: CoreContext, planId: string): Promise<Member[]> {
  return ctx.repo.table('members').list({ filter: { planId } });
}

/** Monthly recurring revenue implied by active members. */
export async function computeMrr(ctx: CoreContext): Promise<{ mrrCents: number; activeMembers: number }> {
  const [members, plans] = await Promise.all([
    ctx.repo.table('members').list({ filter: { status: 'active' } }),
    plansRepo(ctx).list(),
  ]);
  const priceByPlan = new Map(plans.map((p) => [p.id, p.priceCents] as const));
  let mrrCents = 0;
  for (const member of members) {
    const fromPlan = priceByPlan.get(member.planId);
    mrrCents += fromPlan ?? member.monthlyPriceCents ?? 0;
  }
  return { mrrCents, activeMembers: members.length };
}