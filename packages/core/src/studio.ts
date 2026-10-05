import {
  AppError,
  DEFAULT_CURRENCY,
  limitReached,
  newStudioId,
  notFound,
  tierAtLeast,
  type CatalogPlan,
  type PlanTier,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { DEFAULT_SETTINGS, DEFAULT_STUDIO, getStudioSettings } from './context.js';
import type { Repository, Studio as StudioRow } from './repository.js';

export function studiosRepo(ctx: CoreContext) {
  return ctx.repo.table('studios');
}

/**
 * Returns the studio for this context, provisioning the demo studio on first
 * use so a fresh checkout works with no configuration at all.
 */
export async function getStudio(ctx: CoreContext): Promise<StudioRow> {
  const id = ctx.studioId ?? DEFAULT_STUDIO.id;
  const existing = await studiosRepo(ctx).findById(id);
  if (existing) return existing;
  const created: StudioRow = {
    ...DEFAULT_STUDIO,
    id,
    name: id === DEFAULT_STUDIO.id ? DEFAULT_STUDIO.name : 'My Studio',
    settings: { ...DEFAULT_SETTINGS },
  };
  return studiosRepo(ctx).insert(created);
}

export async function listStudios(ctx: CoreContext): Promise<StudioRow[]> {
  return studiosRepo(ctx).list({ order: { field: 'createdAt', dir: 'asc' } });
}

export async function createStudio(
  ctx: CoreContext,
  input: { name: string; tier?: PlanTier; timezone?: string; currency?: StudioRow['currency']; ownerId?: string },
): Promise<StudioRow> {
  const at = ctx.now().toISOString();
  return studiosRepo(ctx).insert({
    id: newStudioId(),
    name: input.name,
    ownerId: input.ownerId,
    tier: input.tier ?? 'free',
    timezone: input.timezone ?? 'UTC',
    currency: input.currency ?? DEFAULT_CURRENCY,
    settings: { ...DEFAULT_SETTINGS },
    createdAt: at,
    updatedAt: at,
  });
}

export async function updateStudio(
  ctx: CoreContext,
  id: string,
  patch: Partial<Omit<StudioRow, 'id'>>,
): Promise<StudioRow> {
  const existing = await studiosRepo(ctx).findById(id ?? ctx.studioId ?? '');
  if (!existing) throw notFound('Studio', id);
  return studiosRepo(ctx).update(existing.id, { ...patch, updatedAt: ctx.now().toISOString() });
}

/** The plan a studio is currently subscribed to (free unless upgraded). */
export async function getStudioPlan(ctx: CoreContext): Promise<CatalogPlan> {
  const { PLAN_CATALOG } = await import('@studiodesk/shared');
  const studio = await getStudio(ctx);
  return PLAN_CATALOG[studio.tier] ?? PLAN_CATALOG.free;
}

export async function getPlanLimits(ctx: CoreContext) {
  return (await getStudioPlan(ctx)).limits;
}

export async function setStudioTier(
  ctx: CoreContext,
  tier: PlanTier,
): Promise<StudioRow> {
  return updateStudio(ctx, ctx.studioId ?? '', { tier });
}

/* -------------------------------------------------------------------------- */
/* Limit enforcement                                                          */
/* -------------------------------------------------------------------------- */

export async function assertMemberCapacity(ctx: CoreContext, adding = 1): Promise<void> {
  const limits = await getPlanLimits(ctx);
  if (limits.maxMembers === null) return;
  const active = await ctx.repo.table('members').count({ filter: { status: 'active' } });
  if (active + adding > limits.maxMembers) {
    throw limitReached(
      `Your plan allows ${limits.maxMembers} active members. Upgrade to add more.`,
      { active, max: limits.maxMembers, adding },
    );
  }
}

/**
 * The free tier is limited to a single class *type*. Two "Vinyasa" classes on
 * different days are one type; "Vinyasa" and "Restorative" are two.
 */
export async function assertClassTypeAllowed(ctx: CoreContext, classType?: string): Promise<void> {
  const limits = await getPlanLimits(ctx);
  if (limits.maxClassTypes === null) return;
  const type = (classType ?? 'default').trim() || 'default';
  const existing = await ctx.repo.table('classes').list({ filter: { classType: type }, limit: 1 });
  if (existing.length) return;
  const used = await ctx.repo.table('classes').list({ limit: 1000 });
  const types = new Set(used.map((row) => (row.classType ?? 'default').trim() || 'default'));
  if (types.size + 1 > limits.maxClassTypes) {
    throw limitReached(
      `Your plan allows ${limits.maxClassTypes} class type. Upgrade for unlimited class types.`,
      { used: [...types], max: limits.maxClassTypes },
    );
  }
}

export async function assertFeature(ctx: CoreContext, feature: keyof ReturnType<typeof planFeatureMap>): Promise<void> {
  const plan = await getStudioPlan(ctx);
  if (!plan.limits[feature]) {
    throw new AppError('forbidden', `${capitalise(feature)} is not available on the ${plan.name} plan`, {
      feature,
      tier: plan.tier,
      requiredTier: featureTier(feature),
    });
  }
}

function featureTier(feature: string): PlanTier {
  if (feature === 'waitlist' || feature === 'qrCheckin' || feature === 'customBranding') return 'starter';
  return 'business';
}

function planFeatureMap() {
  return {
    waitlist: true,
    qrCheckin: true,
    kioskMode: true,
    churnAi: true,
    dunning: true,
    customBranding: true,
    apiAccess: true,
  } as const;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Convenience for `requireFeature`-style gating in the UI. */
export async function hasFeature(ctx: CoreContext, feature: keyof ReturnType<typeof planFeatureMap>): Promise<boolean> {
  const plan = await getStudioPlan(ctx);
  return Boolean(plan.limits[feature]);
}

/**
 * Validates that a plan id belongs to this studio. Platform plans use a `tier`
 * column; member-facing plans are studio-scoped rows.
 */
export function isStudioPlan(plan: { studioId?: string }, studioId: string | undefined): boolean {
  return !plan.studioId || !studioId || plan.studioId === studioId;
}

export { DEFAULT_SETTINGS, getStudioSettings, tierAtLeast };
export type { CoreContext, Repository };