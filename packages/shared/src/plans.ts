import type { CatalogPlan, Currency, PlanLimits, PlanTier } from './types.js';

export const PLAN_TIERS: PlanTier[] = ['free', 'starter', 'business'];

/**
 * Platform plans (what a *studio* pays StudioDesk for). These are NOT the
 * member-facing membership plans, which are per-studio records in `plans`.
 *
 *   free     - $0   - one class type, 30 members, everything essential
 *   starter  - $39  - unlimited class types, 150 members, waitlists + QR
 *   business - $99  - unlimited members, churn AI, dunning, kiosk, API
 */
export const PLAN_CATALOG: Record<PlanTier, CatalogPlan> = {
  free: {
    tier: 'free',
    name: 'Free',
    priceCents: 0,
    yearlyPriceCents: 0,
    currency: 'usd',
    tagline: 'One class type. Everything you need to get off spreadsheets.',
    highlighted: false,
    features: [
      '1 class type',
      'Up to 30 active members',
      'Members, schedule & attendance',
      'Manual check-in',
      'Community support',
    ],
    limits: {
      maxMembers: 30,
      maxClassTypes: 1,
      maxInstructors: 2,
      waitlist: false,
      qrCheckin: false,
      kioskMode: false,
      churnAi: false,
      dunning: false,
      customBranding: false,
      apiAccess: false,
      reportRetentionDays: 30,
      seats: 1,
    },
  },
  starter: {
    tier: 'starter',
    name: 'Starter',
    priceCents: 3900,
    yearlyPriceCents: 39_000,
    currency: 'usd',
    tagline: 'For studios running a real timetable with a waitlist.',
    highlighted: true,
    features: [
      'Unlimited class types',
      'Up to 150 active members',
      'Waitlists with auto-promotion',
      'QR check-in + mobile app',
      'Class packs, drop-ins & fees',
      'Branded PDF invoices',
      'Email support',
    ],
    limits: {
      maxMembers: 150,
      maxClassTypes: null,
      maxInstructors: 10,
      waitlist: true,
      qrCheckin: true,
      kioskMode: false,
      churnAi: false,
      dunning: false,
      customBranding: true,
      apiAccess: false,
      reportRetentionDays: 365,
      seats: 3,
    },
  },
  business: {
    tier: 'business',
    name: 'Business',
    priceCents: 9900,
    yearlyPriceCents: 99_000,
    currency: 'usd',
    tagline: 'Multi-instructor studios that need churn prediction and hands-off billing.',
    highlighted: false,
    features: [
      'Unlimited members',
      'Everything in Starter',
      'Churn prediction (Groq AI)',
      'Smart dunning & recovery',
      'Kiosk / tablet mode',
      'Open API + webhooks',
      'Priority support',
    ],
    limits: {
      maxMembers: null,
      maxClassTypes: null,
      maxInstructors: null,
      waitlist: true,
      qrCheckin: true,
      kioskMode: true,
      churnAi: true,
      dunning: true,
      customBranding: true,
      apiAccess: true,
      reportRetentionDays: 1095,
      seats: 10,
    },
  },
};

export const PLAN_ORDER: PlanTier[] = ['free', 'starter', 'business'];

export function getCatalogPlan(tier: PlanTier): CatalogPlan {
  return PLAN_CATALOG[tier];
}

export function limitsForTier(tier: PlanTier): PlanLimits {
  return PLAN_CATALOG[tier]?.limits ?? PLAN_CATALOG.free.limits;
}

export function tierIndex(tier: PlanTier): number {
  const idx = PLAN_ORDER.indexOf(tier);
  return idx === -1 ? 0 : idx;
}

export function tierAtLeast(current: PlanTier, required: PlanTier): boolean {
  return tierIndex(current) >= tierIndex(required);
}

/** Human-readable list of the plan's hard limits, used in the marketing page. */
export function describeLimits(tier: PlanTier): string[] {
  const l = limitsForTier(tier);
  const out: string[] = [];
  out.push(l.maxMembers === null ? 'Unlimited members' : `Up to ${l.maxMembers} active members`);
  out.push(l.maxClassTypes === null ? 'Unlimited class types' : `${l.maxClassTypes} class type`);
  if (l.waitlist) out.push('Waitlists with auto-promotion');
  if (l.qrCheckin) out.push('QR check-in');
  if (l.churnAi) out.push('Churn prediction');
  if (l.dunning) out.push('Smart dunning');
  if (l.kioskMode) out.push('Kiosk mode');
  if (l.apiAccess) out.push('Open API');
  return out;
}

/** Default currency used when nothing else is specified. */
export const DEFAULT_CURRENCY: Currency = 'usd';