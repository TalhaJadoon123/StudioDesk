import {
  DAY_MS,
  config,
  sortBy,
  type ChurnBand,
  type ChurnReport,
  type Member,
  type MemberWithUsage,
  type ReportRange,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { churnBandFor, memberUsage, type MemberUsage, type RiskFeatures } from './members.js';
import { listPlans } from './plans.js';
import { isGroqConfigured, askJson } from './groq.js';
import { hasFeature } from './studio.js';

/**
 * Churn prediction.
 *
 * Two layers:
 *   1. `heuristicRisk()` in members.ts - deterministic, explainable, free.
 *      Always runs. Produces the 0..1 risk score and the signal breakdown.
 *   2. Groq (free tier) - turns the signals into a written reason and a
 *      concrete next action for the studio owner. Skipped entirely when no key
 *      is configured or when the studio is not on the Business plan.
 *
 * The LLM never changes the score; it only explains it. That keeps results
 * reproducible in tests and prevents a hallucination from billing decisions.
 */

export interface ChurnSignal {
  code: string;
  label: string;
  /** Signed contribution to the final score. */
  weight: number;
  severity: 'positive' | 'warning' | 'critical';
}

export interface ChurnPrediction {
  memberId: string;
  memberName: string;
  planId: string;
  risk: number;
  band: ChurnBand;
  signals: ChurnSignal[];
  explanation: string;
  recommendation: string;
  suggestedOffer?: string;
  estimatedLossCents: number;
  /** True when Groq produced the explanation. */
  ai: boolean;
  model?: string;
  features: RiskFeatures & { packCredits: number };
}

/* -------------------------------------------------------------------------- */
/* Signals                                                                    */
/* -------------------------------------------------------------------------- */

export function deriveSignals(f: RiskFeatures & { packCredits?: number }): ChurnSignal[] {
  const signals: ChurnSignal[] = [];

  const push = (code: string, label: string, weight: number): void => {
    signals.push({
      code,
      label,
      weight: Number(weight.toFixed(3)),
      severity: weight >= 0.25 ? 'critical' : weight >= 0.1 ? 'warning' : 'positive',
    });
  };

  if (f.visitsPrev30Days > 0 && f.visitsLast30Days < f.visitsPrev30Days) {
    const drop = Math.round((1 - f.visitsLast30Days / f.visitsPrev30Days) * 100);
    push('frequency-drop', `Visit frequency down ${drop}% (${f.visitsPrev30Days} -> ${f.visitsLast30Days} in 30 days)`, drop > 60 ? 0.3 : drop > 40 ? 0.2 : 0.1);
  }
  if (f.daysSinceLastVisit === null) push('never-visited', 'Has never checked in', 0.3);
  else if (f.daysSinceLastVisit > 21) push('lapsed', `No visit for ${f.daysSinceLastVisit} days`, f.daysSinceLastVisit > 45 ? 0.28 : 0.18);

  if (f.attendanceRate > 0 && f.attendanceRate < 0.7) {
    push('low-attendance', `Only ${Math.round(f.attendanceRate * 100)}% of bookings attended`, 0.12);
  }
  if (f.lateCancels >= 1) push('late-cancels', `${f.lateCancels} late cancellation(s)`, f.lateCancels >= 3 ? 0.1 : 0.05);
  if (f.noShows >= 1) push('no-shows', `${f.noShows} no-show(s)`, f.noShows >= 3 ? 0.12 : 0.06);
  if (f.outstandingCents > 0) push('outstanding-balance', 'Has an unpaid balance', 0.15);
  if (f.upcomingBookings === 0) push('no-upcoming', 'Nothing booked in the schedule', 0.12);
  if (f.tenureDays < 30 && f.tenureDays >= 0) push('new-member', `Only ${f.tenureDays} days since joining`, -0.25);
  if (f.visitsLast30Days >= 8 && (f.daysSinceLastVisit ?? 99) <= 7) {
    push('strong-habit', `${f.visitsLast30Days} visits in the last 30 days`, -0.2);
  }
  if ((f.packCredits ?? 0) === 0 && f.upcomingBookings === 0) {
    push('no-credits', 'No class credits remaining', 0.08);
  }

  return sortBy(signals, (s) => Math.abs(s.weight), 'desc');
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

export async function scoreMember(ctx: CoreContext, memberId: string): Promise<ChurnPrediction> {
  const usage = await memberUsage(ctx, memberId);
  return predictionFromUsage(usage);
}

export function predictionFromUsage(usage: MemberUsage): ChurnPrediction {
  const features: RiskFeatures & { packCredits: number } = {
    visitsLast30Days: usage.visitsLast30Days,
    visitsPrev30Days: usage.visitsPrev30Days,
    daysSinceLastVisit: usage.daysSinceLastVisit,
    attendanceRate: usage.attendanceRate,
    lateCancels: usage.lateCancels,
    noShows: usage.noShows,
    outstandingCents: usage.outstandingCents,
    tenureDays: usage.tenureDays,
    upcomingBookings: usage.upcomingBookings,
    packCredits: usage.packCredits,
  };
  const signals = deriveSignals(features);
  const risk = usage.churnRisk;
  return {
    memberId: usage.id,
    memberName: usage.name,
    planId: usage.planId,
    risk,
    band: churnBandFor(risk),
    signals,
    explanation: heuristicExplanation(usage, signals),
    recommendation: heuristicRecommendation(usage, signals),
    estimatedLossCents: risk >= 0.5 ? usage.monthlyPriceCents ?? 0 : 0,
    ai: false,
    features,
  };
}

function heuristicExplanation(usage: MemberUsage, signals: ChurnSignal[]): string {
  const positives = signals.filter((s) => s.weight > 0);
  const negatives = signals.filter((s) => s.weight < 0);
  if (!positives.length) return 'Engaged member with a stable routine.';

  const parts = positives.slice(0, 3).map((s) => s.label.toLowerCase());
  const reassurance = negatives.length ? ` Offsetting factor: ${negatives[0]!.label.toLowerCase()}.` : '';
  return `${usage.name}: ${parts.join(', ')}.${reassurance}`;
}

function heuristicRecommendation(usage: MemberUsage, signals: ChurnSignal[]): string {
  const codes = signals.map((s) => s.code);
  if (usage.daysSinceLastVisit !== null && usage.daysSinceLastVisit > 21) {
    return `Send a personal check-in text this week and invite them back to a class they used to attend.`;
  }
  if (codes.includes('outstanding-balance')) {
    return 'Resolve the unpaid balance first - churn risk drops sharply once billing is settled.';
  }
  if (codes.includes('no-credits')) {
    return `Offer a class pack - ${usage.name} has nothing left to book with.`;
  }
  if (codes.includes('low-attendance')) {
    return 'Call them: they are booking but not turning up. Likely a schedule clash.';
  }
  if (codes.includes('new-member')) {
    return 'Too early to judge. Book them into their next class to build the habit.';
  }
  if (usage.upcomingBookings === 0) {
    return 'Nothing booked - nudge them into the next session in their usual time slot.';
  }
  return 'Monitor. No action needed yet.';
}

/* -------------------------------------------------------------------------- */
/* Groq enrichment                                                            */
/* -------------------------------------------------------------------------- */

export interface EnrichOptions {
  /** Force Groq even without a key (tests inject one). */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Batch size sent to the model in one call. */
  batchSize?: number;
  signal?: AbortSignal;
}

interface GroqBatchResponse {
  members: Array<{
    memberId: string;
    explanation: string;
    recommendation: string;
    suggestedOffer?: string;
  }>;
  studioInsights: string[];
}

const SYSTEM_PROMPT = `You are the retention analyst for a small fitness or yoga studio.
You are given anonymised per-member usage signals and a churn risk score computed by a deterministic model.

Rules:
- Never contradict or restate the given risk score; explain it.
- One or two sentences per member, plain language, no jargon, no emoji.
- Recommendations must be concrete actions the studio owner can do this week.
- suggestedOffer must name a real product the studio sells (class pack, drop-in, membership freeze) or be omitted.
- studioInsights: 2-4 short studio-wide observations, each under 20 words.
- Respond with JSON only.`;

/** Adds Groq-written explanations on top of the deterministic scores. */
export async function enrichWithGroq(
  ctx: CoreContext,
  predictions: ChurnPrediction[],
  options: EnrichOptions = {},
): Promise<{ predictions: ChurnPrediction[]; insights: string[]; model?: string }> {
  const apiKey = options.apiKey ?? config.groqApiKey();
  if (!apiKey || !predictions.length) return { predictions, insights: [] };
  if (!(await hasFeature(ctx, 'churnAi'))) return { predictions, insights: [] };

  const risky = predictions.filter((p) => p.band !== 'low').slice(0, 40);
  if (!risky.length) return { predictions, insights: [] };

  const enriched = new Map<string, ChurnBatchMember>();
  const allInsights: string[] = [];
  let model: string | undefined;
  const batchSize = options.batchSize ?? 12;

  for (let i = 0; i < risky.length; i += batchSize) {
    const batch = risky.slice(i, i + batchSize);
    const payload = {
      studio: studioContext(ctx),
      members: batch.map((p) => ({
        memberId: p.memberId,
        risk: p.risk,
        band: p.band,
        features: p.features,
        signals: p.signals.map((s) => ({ label: s.label, weight: s.weight })),
        plan: p.planId,
      })),
    };

    let response: GroqBatchResponse | null = null;
    try {
      response = await askJson<GroqBatchResponse>(SYSTEM_PROMPT, JSON.stringify(payload), {
        apiKey,
        model: options.model,
        json: true,
        temperature: 0.4,
        maxTokens: 1200,
        timeoutMs: options.timeoutMs ?? 20_000,
        retries: 1,
        signal: options.signal,
      });
    } catch {
      // AI is a bonus. Keep the heuristic explanation and move on.
      response = null;
    }
    if (!response) continue;

    model = options.model ?? config.groqModel();
    for (const member of response.members ?? []) {
      if (member?.memberId) enriched.set(member.memberId, member);
    }
    allInsights.push(...(response.studioInsights ?? []));
  }

  return {
    predictions: predictions.map((prediction) => {
      const ai = enriched.get(prediction.memberId);
      if (!ai) return prediction;
      return {
        ...prediction,
        explanation: ai.explanation?.trim() || prediction.explanation,
        recommendation: ai.recommendation?.trim() || prediction.recommendation,
        suggestedOffer: ai.suggestedOffer?.trim() || prediction.suggestedOffer,
        ai: true,
        model,
      };
    }),
    insights: allInsights,
    model,
  };
}

interface ChurnBatchMember {
  memberId: string;
  explanation: string;
  recommendation: string;
  suggestedOffer?: string;
}

function studioContext(ctx: CoreContext): Record<string, unknown> {
  return {
    asOf: ctx.now().toISOString(),
    timezone: 'UTC',
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function predictChurn(
  ctx: CoreContext,
  options: { memberIds?: string[]; status?: Member['status']; limit?: number; enrich?: boolean } = {},
): Promise<ChurnPrediction[]> {
  const members = options.memberIds
    ? await Promise.all(options.memberIds.map((id) => ctx.repo.table('members').findById(id)))
    : await ctx.repo
        .table('members')
        .list(options.status ? { filter: { status: options.status } } : {});

  const usages = await Promise.all(
    members.filter((m): m is Member => Boolean(m)).map((m) => memberUsage(ctx, m.id)),
  );
  const predictions = usages.map(predictionFromUsage);
  const limited = sortBy(predictions, (p) => p.risk, 'desc').slice(0, options.limit ?? 100);

  if (options.enrich === false) return limited;
  const { predictions: enriched, insights } = await enrichWithGroq(ctx, limited);
  lastInsights = insights;
  return enriched;
}

/** Insights produced by the most recent `predictChurn({ enrich: true })`. */
let lastInsights: string[] = [];
export function takeInsights(): string[] {
  const out = lastInsights;
  lastInsights = [];
  return out;
}

export async function churnReport(
  ctx: CoreContext,
  range?: Partial<ReportRange>,
  options: { enrich?: boolean } = {},
): Promise<ChurnReport> {
  const now = ctx.now();
  const from = range?.from ?? new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const to = range?.to ?? now.toISOString();

  const [members, plans] = await Promise.all([
    ctx.repo.table('members').list(),
    listPlans(ctx),
  ]);
  const active = members.filter((m) => m.status === 'active');
  const cancelled = members.filter((m) => m.status === 'cancelled');
  const churnedLast30Days = cancelled.filter((m) => (m.cancelledAt ?? '') >= from && (m.cancelledAt ?? '') <= to);
  const priceByPlan = new Map(plans.map((p) => [p.id, p.priceCents] as const));

  const usages = await Promise.all(active.map((m) => memberUsage(ctx, m.id)));
  const predictions = usages.map(predictionFromUsage);
  const atRisk = sortBy(
    predictions.filter((p) => p.band === 'high' || p.band === 'at-risk'),
    (p) => p.risk,
    'desc',
  );

  let insights: string[] = [];
  if (options.enrich !== false) {
    const result = await enrichWithGroq(ctx, atRisk);
    insights = result.insights;
    lastInsights = insights;
    for (const enriched of result.predictions) {
      const index = atRisk.findIndex((p) => p.memberId === enriched.memberId);
      if (index !== -1) atRisk[index] = enriched;
    }
  }

  const retainedCents = active.reduce((acc, m) => acc + (priceByPlan.get(m.planId) ?? m.monthlyPriceCents ?? 0), 0);

  const byPlan = plans
    .filter((plan) => plan.active)
    .map((plan) => {
      const onPlan = active.filter((m) => m.planId === plan.id);
      const risky = atRisk.filter((p) => p.planId === plan.id);
      return {
        planId: plan.id,
        name: plan.name,
        members: onPlan.length,
        atRisk: risky.length,
        mrrCents: onPlan.length * plan.priceCents,
      };
    })
    .filter((row) => row.members > 0);

  return {
    from,
    to,
    totalMembers: members.length,
    activeMembers: active.length,
    churnedLast30Days: churnedLast30Days.length,
    churnRate: active.length ? Number((churnedLast30Days.length / active.length).toFixed(3)) : 0,
    retainedCents,
    atRisk: atRisk
      .slice(0, 25)
      .map((prediction) => toMemberWithUsage(prediction, usages)),
    byPlan,
    insights: insights.length ? insights : templateInsights(atRisk, usages),
  };
}

function toMemberWithUsage(prediction: ChurnPrediction, usages: MemberUsage[]): MemberWithUsage {
  const usage = usages.find((u) => u.id === prediction.memberId)!;
  return usage;
}

function templateInsights(atRisk: ChurnPrediction[], usages: MemberUsage[]): string[] {
  const out: string[] = [];
  const total = usages.length;
  const risky = atRisk.length;

  out.push(
    `${risky} of ${total} active members are flagged medium risk or higher (${total ? Math.round((risky / total) * 100) : 0}%).`,
  );

  const lapsed = atRisk.filter((p) => (p.features.daysSinceLastVisit ?? 0) > 21);
  if (lapsed.length) out.push(`${lapsed.length} member(s) have not visited in 3+ weeks - a personal message recovers most of them.`);

  const noCredits = atRisk.filter((p) => p.features.packCredits === 0 && p.features.outstandingCents === 0);
  if (noCredits.length) out.push(`${noCredits.length} member(s) have run out of credits - a pack nudge is the cheapest win.`);

  const healthy = usages.filter((u) => u.visitsLast30Days >= 6).length;
  if (healthy) out.push(`${healthy} member(s) visited 6+ times this month - consider inviting them to teach or refer.`);

  const owed = usages.reduce((acc, u) => acc + u.outstandingCents, 0);
  if (owed > 0) out.push(`Outstanding member balances total ${(owed / 100).toFixed(2)} - run dunning before it ages.`);

  return out;
}

export async function atRiskMembers(
  ctx: CoreContext,
  threshold = 0.5,
): Promise<MemberWithUsage[]> {
  const predictions = await predictChurn(ctx, { status: 'active', enrich: false });
  const ids = new Set(predictions.filter((p) => p.risk >= threshold).map((p) => p.memberId));
  const usages = await Promise.all(
    [...ids].map((id) => memberUsage(ctx, id).catch(() => null)),
  );
  return sortBy(
    usages.filter((u): u is MemberUsage => Boolean(u)),
    (u) => u.churnRisk,
    'desc',
  );
}

export function isGroqEnabled(): boolean {
  return isGroqConfigured();
}

export { churnBandFor };