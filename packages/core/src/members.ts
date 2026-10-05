import {
  AppError,
  DAY_MS,
  conflict,
  newMemberId,
  notFound,
  nowIso,
  sortBy,
  type ChurnBand,
  type Member,
  type MemberStatus,
  type MemberWithUsage,
  type Paginated,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { assertMemberCapacity, getStudio } from './studio.js';
import type { Filter } from './repository.js';

export const CHURN_BANDS: Array<{ band: ChurnBand; min: number }> = [
  { band: 'at-risk', min: 0.75 },
  { band: 'high', min: 0.5 },
  { band: 'medium', min: 0.25 },
  { band: 'low', min: 0 },
];

export function churnBandFor(risk: number): ChurnBand {
  for (const { band, min } of CHURN_BANDS) if (risk >= min) return band;
  return 'low';
}

export function membersRepo(ctx: CoreContext) {
  return ctx.repo.table('members');
}

function applySearch(rows: Member[], search?: string): Member[] {
  if (!search) return rows;
  const needle = search.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((m) =>
    [m.name, m.email, m.phone, ...(m.tags ?? [])]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle)),
  );
}

/* -------------------------------------------------------------------------- */
/* CRUD                                                                       */
/* -------------------------------------------------------------------------- */

export async function createMember(
  ctx: CoreContext,
  input: {
    name: string;
    email?: string;
    phone?: string;
    planId?: string;
    status?: MemberStatus;
    joinedAt?: string;
    monthlyPriceCents?: number;
    currency?: Member['currency'];
    tags?: string[];
    notes?: string;
    kioskPin?: string;
    marketingOptIn?: boolean;
  },
): Promise<Member> {
  const studio = await getStudio(ctx);
  if (input.email) {
    const existing = await membersRepo(ctx).findOne({ filter: { email: input.email.toLowerCase() } });
    if (existing) throw conflict(`A member with email ${input.email} already exists`, { memberId: existing.id });
  }
  if ((input.status ?? 'active') === 'active') await assertMemberCapacity(ctx, 1);

  const at = ctx.now().toISOString();
  const member: Member = {
    id: newMemberId(),
    name: input.name,
    email: input.email?.toLowerCase(),
    phone: input.phone,
    planId: input.planId ?? 'none',
    status: input.status ?? 'active',
    studioId: studio.id,
    monthlyPriceCents: input.monthlyPriceCents ?? 0,
    currency: input.currency ?? studio.currency,
    joinedAt: input.joinedAt ?? at,
    tags: input.tags ?? [],
    notes: input.notes,
    kioskPin: input.kioskPin,
    marketingOptIn: input.marketingOptIn ?? false,
    createdAt: at,
    updatedAt: at,
  };
  const created = await membersRepo(ctx).insert(member);
  await ctx.events.emit('member.created', { memberId: created.id, name: created.name });
  return created;
}

export async function getMember(ctx: CoreContext, id: string): Promise<Member | null> {
  return membersRepo(ctx).findById(id);
}

export async function requireMember(ctx: CoreContext, id: string): Promise<Member> {
  const member = await getMember(ctx, id);
  if (!member) throw notFound('Member', id);
  return member;
}

export async function updateMember(
  ctx: CoreContext,
  id: string,
  patch: Partial<Member>,
): Promise<Member> {
  const member = await requireMember(ctx, id);
  if (patch.email && patch.email !== member.email) {
    const clash = await membersRepo(ctx).findOne({ filter: { email: patch.email.toLowerCase() } });
    if (clash && clash.id !== id) {
      throw conflict(`A member with email ${patch.email} already exists`, { memberId: clash.id });
    }
  }
  if (patch.status === 'active' && member.status !== 'active') await assertMemberCapacity(ctx, 1);

  const changes = Object.keys(patch).filter((key) => {
    const next = (patch as Record<string, unknown>)[key];
    const current = (member as unknown as Record<string, unknown>)[key];
    return JSON.stringify(next) !== JSON.stringify(current);
  });

  const updated = await membersRepo(ctx).update(id, { ...patch, updatedAt: ctx.now().toISOString() });
  if (changes.length) await ctx.events.emit('member.updated', { memberId: id, changes });
  return updated;
}

export async function deleteMember(ctx: CoreContext, id: string): Promise<boolean> {
  await requireMember(ctx, id);
  // Keep financial history, drop the PII.
  await membersRepo(ctx).remove(id);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

export async function cancelMember(
  ctx: CoreContext,
  id: string,
  reason?: string,
): Promise<Member> {
  const member = await requireMember(ctx, id);
  if (member.status === 'cancelled') return member;
  const at = ctx.now().toISOString();
  const updated = await membersRepo(ctx).update(id, {
    status: 'cancelled',
    cancelledAt: at,
    updatedAt: at,
    notes: reason ? `${member.notes ? `${member.notes}\n` : ''}Cancelled: ${reason}` : member.notes,
  });
  await ctx.events.emit('member.cancelled', { memberId: id });
  return updated;
}

export async function pauseMember(ctx: CoreContext, id: string, days = 30): Promise<Member> {
  const member = await requireMember(ctx, id);
  if (member.status === 'cancelled') throw conflict('Cancelled members cannot be paused');
  const until = new Date(ctx.now().getTime() + days * DAY_MS).toISOString().slice(0, 10);
  const updated = await membersRepo(ctx).update(id, {
    status: 'paused',
    pausedUntil: until,
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.events.emit('member.paused', { memberId: id, until });
  return updated;
}

export async function resumeMember(ctx: CoreContext, id: string): Promise<Member> {
  const member = await requireMember(ctx, id);
  if (member.status === 'cancelled') throw conflict('Cancelled members cannot be resumed');
  await assertMemberCapacity(ctx, 1);
  const updated = await membersRepo(ctx).update(id, {
    status: 'active',
    pausedUntil: undefined,
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.events.emit('member.resumed', { memberId: id });
  return updated;
}

/** Auto-resumes pauses whose end date has passed. Called on roster reads. */
export async function reconcilePauses(ctx: CoreContext): Promise<number> {
  const today = ctx.now().toISOString().slice(0, 10);
  const expired = await membersRepo(ctx).list({ filter: { status: 'paused' } });
  let count = 0;
  for (const member of expired) {
    if (member.pausedUntil && member.pausedUntil <= today) {
      await membersRepo(ctx).update(member.id, { status: 'active', pausedUntil: undefined });
      await ctx.events.emit('member.resumed', { memberId: member.id });
      count += 1;
    }
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export interface ListMembersQuery {
  status?: MemberStatus;
  search?: string;
  planId?: string;
  tag?: string;
  limit?: number;
  offset?: number;
  sort?: 'name' | 'joinedAt' | 'churnRisk' | 'createdAt';
  dir?: 'asc' | 'desc';
  /** Include the usage rollup (a few extra queries per page). */
  withUsage?: boolean;
}

function buildFilter(query: ListMembersQuery): Filter {
  const filter: Filter = {};
  if (query.status) filter.status = query.status;
  if (query.planId) filter.planId = query.planId;
  if (query.tag) filter.tags = { $in: [query.tag] };
  return filter;
}

export async function listMembers(
  ctx: CoreContext,
  query: ListMembersQuery = {},
): Promise<Member[]> {
  const rows = await membersRepo(ctx).list({
    filter: buildFilter(query),
    order: { field: query.sort ?? 'name', dir: query.dir ?? 'asc' },
  });
  const searched = applySearch(rows, query.search);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? searched.length;
  return searched.slice(offset, offset + limit);
}

export async function countMembers(ctx: CoreContext, query: ListMembersQuery = {}): Promise<number> {
  const rows = await membersRepo(ctx).list({ filter: buildFilter(query) });
  return applySearch(rows, query.search).length;
}

export async function listMembersPaginated(
  ctx: CoreContext,
  query: ListMembersQuery = {},
): Promise<Paginated<Member>> {
  const [items, total] = await Promise.all([
    listMembers(ctx, { ...query, offset: query.offset ?? 0, limit: query.limit ?? 50 }),
    countMembers(ctx, query),
  ]);
  const pageSize = query.limit ?? 50;
  const offset = query.offset ?? 0;
  return {
    items,
    total,
    page: Math.floor(offset / pageSize) + 1,
    pageSize,
    hasMore: offset + items.length < total,
  };
}

export async function listMembersWithUsage(
  ctx: CoreContext,
  query: ListMembersQuery = {},
): Promise<MemberWithUsage[]> {
  const members = await listMembers(ctx, { ...query, limit: query.limit ?? 200 });
  return Promise.all(members.map((member) => memberUsage(ctx, member.id)));
}

export async function countByStatus(ctx: CoreContext): Promise<Record<MemberStatus, number>> {
  const rows = await membersRepo(ctx).list();
  const out: Record<MemberStatus, number> = { active: 0, paused: 0, cancelled: 0 };
  for (const row of rows) out[row.status] += 1;
  return out;
}

export async function newMembersBetween(ctx: CoreContext, fromIso: string, toIso: string): Promise<number> {
  const rows = await membersRepo(ctx).list({
    filter: { joinedAt: { $gte: fromIso, $lte: toIso } },
  });
  return rows.filter((row) => row.status !== 'cancelled').length;
}

/* -------------------------------------------------------------------------- */
/* Usage rollup (feeds churn prediction and the member detail page)           */
/* -------------------------------------------------------------------------- */

export interface MemberUsage extends MemberWithUsage {
  upcomingBookings: number;
  packCredits: number;
  lifetimeVisits: number;
  totalBookings: number;
}

export async function memberUsage(ctx: CoreContext, id: string): Promise<MemberUsage> {
  const member = await requireMember(ctx, id);
  const now = ctx.now().getTime();
  const from30 = new Date(now - 30 * DAY_MS).toISOString();
  const from60 = new Date(now - 60 * DAY_MS).toISOString();

  const [attendance, bookings, fees, invoices, packs] = await Promise.all([
    ctx.repo.table('attendance').list({ filter: { memberId: id } }),
    ctx.repo.table('bookings').list({ filter: { memberId: id } }),
    ctx.repo.table('fees').list({ filter: { memberId: id } }),
    ctx.repo.table('invoices').list({ filter: { memberId: id } }),
    ctx.repo.table('packs').list({ filter: { memberId: id, status: 'active' } }),
  ]);

  const visitsLast30Days = attendance.filter((a) => a.checkedInAt >= from30).length;
  const visitsPrev30Days = attendance.filter(
    (a) => a.checkedInAt >= from60 && a.checkedInAt < from30,
  ).length;
  const lastVisit = attendance
    .map((a) => a.checkedInAt)
    .sort()
    .at(-1);

  const resolved = bookings.filter((b) => b.status === 'attended' || b.status === 'no-show');
  const attended = resolved.filter((b) => b.status === 'attended').length;
  const noShows = resolved.filter((b) => b.status === 'no-show').length;
  const upcomingBookings = bookings.filter(
    (b) => b.status === 'booked' || b.status === 'waitlisted',
  ).length;

  const outstandingCents = invoices
    .filter((inv) => inv.status === 'open')
    .reduce((acc, inv) => acc + (inv.amountDueCents ?? 0), 0);

  const noShowFees = fees.filter((f) => f.kind === 'no-show' && f.status !== 'waived' && f.status !== 'void').length;
  const lateCancelFees = fees.filter((f) => f.kind === 'late-cancel' && f.status !== 'waived' && f.status !== 'void').length;

  // Risk is a pure function of these numbers; churn.ts adds the AI narrative.
  const risk = heuristicRisk({
    visitsLast30Days,
    visitsPrev30Days,
    daysSinceLastVisit: lastVisit ? Math.floor((now - Date.parse(lastVisit)) / DAY_MS) : null,
    attendanceRate: resolved.length ? attended / resolved.length : 1,
    lateCancels: lateCancelFees,
    noShows: noShowFees + noShows,
    outstandingCents,
    tenureDays: member.joinedAt ? Math.floor((now - Date.parse(member.joinedAt)) / DAY_MS) : 0,
    upcomingBookings,
  });

  return {
    ...member,
    visitsLast30Days,
    visitsPrev30Days,
    daysSinceLastVisit: lastVisit ? Math.floor((now - Date.parse(lastVisit)) / DAY_MS) : null,
    attendanceRate: resolved.length ? Number((attended / resolved.length).toFixed(3)) : 1,
    lateCancels: lateCancelFees,
    noShows: noShowFees,
    outstandingCents,
    tenureDays: member.joinedAt ? Math.max(0, Math.floor((now - Date.parse(member.joinedAt)) / DAY_MS)) : 0,
    churnRisk: risk,
    churnBand: churnBandFor(risk),
    upcomingBookings,
    packCredits: packs.reduce((acc, p) => acc + (p.creditsRemaining ?? 0), 0),
    lifetimeVisits: attendance.length,
    totalBookings: bookings.length,
  };
}

export interface RiskFeatures {
  visitsLast30Days: number;
  visitsPrev30Days: number;
  daysSinceLastVisit: number | null;
  attendanceRate: number;
  lateCancels: number;
  noShows: number;
  outstandingCents: number;
  tenureDays: number;
  upcomingBookings: number;
}

/**
 * Deterministic churn heuristic (0..1). This is the baseline that always runs:
 * it is explainable, instant and free. Groq refines the *explanation* on top of
 * it, never the hard number.
 */
export function heuristicRisk(f: RiskFeatures): number {
  let score = 0;

  // Frequency drop-off is the strongest signal.
  if (f.visitsPrev30Days > 0) {
    const ratio = f.visitsLast30Days / f.visitsPrev30Days;
    if (ratio <= 0) score += 0.45;
    else if (ratio < 0.5) score += 0.3;
    else if (ratio < 0.75) score += 0.15;
  } else if (f.visitsLast30Days === 0) {
    // No recent history at all.
    score += 0.3;
  }

  // Lapsed since last visit.
  const gap = f.daysSinceLastVisit ?? 999;
  if (gap > 45) score += 0.28;
  else if (gap > 30) score += 0.22;
  else if (gap > 21) score += 0.15;
  else if (gap > 14) score += 0.08;
  else if (gap <= 6) score -= 0.12;

  // Behavioural friction.
  if (f.attendanceRate < 0.6 && f.attendanceRate > 0) score += 0.1;
  if (f.lateCancels >= 3) score += 0.1;
  else if (f.lateCancels >= 1) score += 0.05;
  if (f.noShows >= 3) score += 0.12;
  else if (f.noShows >= 1) score += 0.06;

  // Money problems.
  if (f.outstandingCents > 0) score += 0.15;
  if (f.outstandingCents > 5000) score += 0.05;

  // Nothing booked ahead.
  if (f.upcomingBookings === 0) score += 0.12;

  // Brand new members churn constantly - be patient with them.
  if (f.tenureDays < 30) score -= 0.25;
  else if (f.tenureDays < 60) score -= 0.1;
  // Loyal, high-frequency members are safe.
  if (f.visitsLast30Days >= 8 && gap <= 7) score -= 0.2;

  const clamped = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  return clamped;
}

/* -------------------------------------------------------------------------- */
/* Detail view                                                                */
/* -------------------------------------------------------------------------- */

export interface MemberDetail {
  member: MemberUsage;
  upcoming: Array<{ bookingId: string; classId: string; className: string; startTime: string; status: string }>;
  history: Array<{ bookingId: string; classId: string; className: string; startTime: string; status: string }>;
  packs: Array<{ id: string; name: string; creditsRemaining: number; expiresAt?: string; status: string }>;
  invoices: Array<{ id: string; number: string; totalCents: number; status: string; createdAt?: string }>;
  fees: Array<{ id: string; kind: string; amountCents: number; status: string; assessedAt: string }>;
  stats: {
    lifetimeVisits: number;
    attendanceRate: number;
    lastVisitAt: string | null;
    revenueCents: number;
    outstandingCents: number;
    avgVisitsPerWeek: number;
  };
}

export async function getMemberDetail(ctx: CoreContext, id: string): Promise<MemberDetail> {
  const usage = await memberUsage(ctx, id);
  const bookings = sortBy(await ctx.repo.table('bookings').list({ filter: { memberId: id } }), (b) => b.bookedAt ?? '', 'asc');
  const classes = await ctx.repo.table('classes').list();
  const classById = new Map(classes.map((c) => [c.id, c]));

  const decorate = (booking: (typeof bookings)[number]) => {
    const klass = classById.get(booking.classId);
    return {
      bookingId: booking.id,
      classId: booking.classId,
      className: klass?.name ?? 'Unknown class',
      startTime: klass?.startTime ?? '',
      status: booking.status,
    };
  };

  const upcoming = bookings
    .filter((b) => b.status === 'booked' || b.status === 'waitlisted')
    .map(decorate)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  const history = bookings
    .filter((b) => b.status === 'attended' || b.status === 'no-show' || b.status === 'cancelled')
    .map(decorate)
    .sort((a, b) => b.startTime.localeCompare(a.startTime))
    .slice(0, 50);

  const [packs, invoices, fees, attendance] = await Promise.all([
    ctx.repo.table('packs').list({ filter: { memberId: id } }),
    ctx.repo.table('invoices').list({ filter: { memberId: id } }),
    ctx.repo.table('fees').list({ filter: { memberId: id } }),
    ctx.repo.table('attendance').list({ filter: { memberId: id } }),
  ]);

  const revenueCents = invoices
    .filter((inv) => inv.status === 'paid')
    .reduce((acc, inv) => acc + inv.totalCents, 0);

  const lastVisitAt = attendance.map((a) => a.checkedInAt).sort().at(-1) ?? null;
  const weeks = Math.max(1, usage.tenureDays / 7);

  return {
    member: usage,
    upcoming,
    history,
    packs: packs.map((p) => ({
      id: p.id,
      name: p.name,
      creditsRemaining: p.creditsRemaining,
      expiresAt: p.expiresAt,
      status: p.status,
    })),
    invoices: sortBy(invoices, (i) => i.createdAt ?? '', 'desc').slice(0, 25).map((i) => ({
      id: i.id,
      number: i.number,
      totalCents: i.totalCents,
      status: i.status,
      createdAt: i.createdAt,
    })),
    fees: sortBy(fees, (f) => f.assessedAt, 'desc').slice(0, 25).map((f) => ({
      id: f.id,
      kind: f.kind,
      amountCents: f.amountCents,
      status: f.status,
      assessedAt: f.assessedAt,
    })),
    stats: {
      lifetimeVisits: attendance.length,
      attendanceRate: usage.attendanceRate,
      lastVisitAt,
      revenueCents,
      outstandingCents: usage.outstandingCents,
      avgVisitsPerWeek: Number((usage.lifetimeVisits / weeks).toFixed(1)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Bulk operations                                                            */
/* -------------------------------------------------------------------------- */

export async function bulkUpdateStatus(
  ctx: CoreContext,
  ids: string[],
  status: MemberStatus,
): Promise<number> {
  let changed = 0;
  for (const id of ids) {
    const member = await membersRepo(ctx).findById(id);
    if (!member || member.status === status) continue;
    if (status === 'cancelled') await cancelMember(ctx, id, 'bulk update');
    else if (status === 'paused') await pauseMember(ctx, id);
    else await resumeMember(ctx, id);
    changed += 1;
  }
  return changed;
}

export async function findMemberByEmail(ctx: CoreContext, email: string): Promise<Member | null> {
  return membersRepo(ctx).findOne({ filter: { email: email.toLowerCase() } });
}

/**
 * Guards a booking attempt. `now` is injected rather than read from
 * `Date.now()` so that scheduling rules follow the caller's clock.
 */
export function assertBookable(member: Member, klass?: { startTime?: string }, now: Date = new Date()): void {
  if (member.status === 'cancelled') {
    throw new AppError('conflict', `${member.name} has cancelled their membership`);
  }
  if (member.status === 'paused') {
    const until = member.pausedUntil ? ` until ${member.pausedUntil}` : '';
    throw new AppError('forbidden', `${member.name}'s membership is paused${until}`);
  }
  // An hour of grace lets late check-ins and same-day bookings through.
  if (klass?.startTime && Date.parse(klass.startTime) < now.getTime() - 60 * 60 * 1000) {
    throw new AppError('conflict', 'That class has already started');
  }
}

export { nowIso };