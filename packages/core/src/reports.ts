import {
  DAY_MS,
  addDays,
  dateOnly,
  startOfDay,
  type AttendanceReport,
  type DashboardSnapshot,
  type ReportRange,
  type RevenuePoint,
  type RevenueReport,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { countByStatus, newMembersBetween } from './members.js';
import { computeMrr, listPlans } from './plans.js';
import { listClasses, listClassesWithCounts, todayClasses } from './classes.js';
import { listAttendance, uniqueVisitors } from './attendance.js';
import { predictChurn } from './churn.js';

export function resolveRange(ctx: CoreContext, range?: Partial<ReportRange> & { days?: number }): ReportRange {
  const to = range?.to ?? ctx.now().toISOString();
  const from = range?.from ?? new Date(Date.parse(to) - (range?.days ?? 30) * DAY_MS).toISOString();
  return { from, to };
}

/* -------------------------------------------------------------------------- */
/* Revenue                                                                    */
/* -------------------------------------------------------------------------- */

interface Bucket {
  grossCents: number;
  feesCents: number;
  packsCents: number;
  dropInsCents: number;
  membershipsCents: number;
  refundsCents: number;
  transactions: number;
}

function emptyBucket(): Bucket {
  return {
    grossCents: 0,
    feesCents: 0,
    packsCents: 0,
    dropInsCents: 0,
    membershipsCents: 0,
    refundsCents: 0,
    transactions: 0,
  };
}

export async function revenueReport(
  ctx: CoreContext,
  rangeInput?: Partial<ReportRange> & { days?: number },
): Promise<RevenueReport> {
  const range = resolveRange(ctx, rangeInput);
  const [invoices, packs, dropIns, fees, classes, bookings, members] = await Promise.all([
    ctx.repo.table('invoices').list(),
    ctx.repo.table('packs').list(),
    ctx.repo.table('dropIns').list(),
    ctx.repo.table('fees').list(),
    ctx.repo.table('classes').list(),
    ctx.repo.table('bookings').list(),
    ctx.repo.table('members').list(),
  ]);

  const inRange = (value?: string) => Boolean(value && value >= range.from && value <= range.to);

  const byDay = new Map<string, Bucket>();
  const dayRange = eachDay(range.from, range.to);
  for (const day of dayRange) byDay.set(day, emptyBucket());

  const totals = emptyBucket();
  const memberName = new Map(members.map((m) => [m.id, m.name] as const));

  for (const invoice of invoices) {
    if (!inRange(invoice.createdAt)) continue;
    const bucket = byDay.get(dateOnly(invoice.createdAt!))!;
    const kind = invoice.lineItems[0]?.kind ?? 'membership';
    if (invoice.status === 'paid') {
      totals.grossCents += invoice.totalCents;
      totals.transactions += 1;
      bucket.grossCents += invoice.totalCents;
      bucket.transactions += 1;
      if (kind === 'class-pack') {
        totals.packsCents += invoice.totalCents;
        bucket.packsCents += invoice.totalCents;
      } else if (kind === 'drop-in') {
        totals.dropInsCents += invoice.totalCents;
        bucket.dropInsCents += invoice.totalCents;
      } else {
        totals.membershipsCents += invoice.totalCents;
        bucket.membershipsCents += invoice.totalCents;
      }
    } else if (invoice.status === 'void' || invoice.status === 'uncollectible') {
      totals.refundsCents += invoice.totalCents;
      bucket.refundsCents += invoice.totalCents;
    }
  }

  // Fees and pack purchases recorded outside an invoice still count as revenue.
  for (const fee of fees) {
    if (!inRange(fee.chargedAt ?? fee.assessedAt)) continue;
    if (fee.status === 'void' || fee.status === 'waived') continue;
    const bucket = byDay.get(dateOnly(fee.chargedAt ?? fee.assessedAt))!;
    const cents = fee.amountCents;
    totals.feesCents += cents;
    totals.grossCents += cents;
    bucket.feesCents += cents;
    bucket.grossCents += cents;
    totals.transactions += 1;
    bucket.transactions += 1;
  }

  for (const pack of packs) {
    if (!inRange(pack.purchasedAt)) continue;
    const bucket = byDay.get(dateOnly(pack.purchasedAt))!;
    totals.packsCents += pack.priceCents;
    totals.grossCents += pack.priceCents;
    bucket.packsCents += pack.priceCents;
    bucket.grossCents += pack.priceCents;
    totals.transactions += 1;
    bucket.transactions += 1;
  }

  for (const dropIn of dropIns) {
    if (!inRange(dropIn.purchasedAt) || dropIn.status === 'refunded') continue;
    const bucket = byDay.get(dateOnly(dropIn.purchasedAt))!;
    totals.dropInsCents += dropIn.priceCents;
    totals.grossCents += dropIn.priceCents;
    bucket.dropInsCents += dropIn.priceCents;
    bucket.grossCents += dropIn.priceCents;
    totals.transactions += 1;
    bucket.transactions += 1;
  }

  const classIdSet = new Set(classes.map((c) => c.id));
  const byClass = new Map<string, { classId: string; name: string; revenueCents: number; bookings: number }>();
  for (const klass of classes) {
    if (!inRange(klass.startTime)) continue;
    byClass.set(klass.id, { classId: klass.id, name: klass.name, revenueCents: 0, bookings: 0 });
  }
  for (const booking of bookings) {
    const row = byClass.get(booking.classId);
    if (!row || !classIdSet.has(booking.classId)) continue;
    if (booking.status === 'attended' || booking.status === 'booked') {
      row.bookings += 1;
      // Attendance value: what a drop-in would have paid (estimated at $18).
      if (booking.status === 'attended') row.revenueCents += 1800;
    }
  }
  const dropInByClass = new Map<string, number>();
  for (const dropIn of dropIns) {
    if (dropIn.status !== 'active') continue;
    if (!inRange(dropIn.purchasedAt)) continue;
    dropInByClass.set(dropIn.classId, (dropInByClass.get(dropIn.classId) ?? 0) + dropIn.priceCents);
  }
  for (const [classId, cents] of dropInByClass) {
    const row = byClass.get(classId);
    if (row) row.revenueCents += cents;
  }

  void memberName;

  const points: RevenuePoint[] = [...byDay.entries()].map(([date, bucket]) => ({
    date,
    grossCents: bucket.grossCents,
    feesCents: bucket.feesCents,
    packsCents: bucket.packsCents,
    dropInsCents: bucket.dropInsCents,
    membershipsCents: bucket.membershipsCents,
    refundsCents: bucket.refundsCents,
    netCents: bucket.grossCents - bucket.refundsCents,
    transactions: bucket.transactions,
  }));

  return {
    ...range,
    grossCents: totals.grossCents,
    netCents: totals.grossCents - totals.refundsCents,
    membershipsCents: totals.membershipsCents,
    packsCents: totals.packsCents,
    dropInsCents: totals.dropInsCents,
    feesCents: totals.feesCents,
    refundsCents: totals.refundsCents,
    transactions: totals.transactions,
    averageTransactionCents: totals.transactions ? Math.round(totals.grossCents / totals.transactions) : 0,
    byDay: points,
    byClass: [...byClass.values()].sort((a, b) => b.revenueCents - a.revenueCents),
  };
}

function eachDay(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let cursor = startOfDay(fromIso);
  const end = startOfDay(toIso);
  // Cap at 400 days so a bad query cannot allocate unbounded memory.
  for (let i = 0; i <= 400; i += 1) {
    const key = dateOnly(cursor);
    out.push(key);
    if (key === dateOnly(end) || cursor.getTime() >= end.getTime()) break;
    cursor = addDays(cursor, 1);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Attendance                                                                 */
/* -------------------------------------------------------------------------- */

export async function attendanceReport(
  ctx: CoreContext,
  rangeInput?: Partial<ReportRange> & { days?: number; instructorId?: string },
): Promise<AttendanceReport> {
  const range = resolveRange(ctx, rangeInput);
  const [classes, bookings, attendance, instructors, packs] = await Promise.all([
    listClasses(ctx, { from: range.from, to: range.to }),
    ctx.repo.table('bookings').list(),
    listAttendance(ctx, { from: range.from, to: range.to }),
    ctx.repo.table('instructors').list(),
    ctx.repo.table('packs').list(),
  ]);

  const scoped = rangeInput?.instructorId
    ? classes.filter((c) => c.instructorId === rangeInput.instructorId)
    : classes;
  const classIds = new Set(scoped.map((c) => c.id));
  const relevant = bookings.filter((b) => classIds.has(b.classId));

  const attended = relevant.filter((b) => b.status === 'attended').length;
  const noShows = relevant.filter((b) => b.status === 'no-show').length;
  const confirmed = relevant.filter((b) => b.status === 'booked' || b.status === 'attended').length;
  const capacity = scoped.reduce((acc, c) => acc + c.capacity, 0);
  const resolved = attended + noShows;

  const classIdsWithAttendance = new Set(attendance.map((a) => a.classId));
  const bookingsByClass = new Map<string, typeof relevant>();
  for (const booking of relevant) {
    const list = bookingsByClass.get(booking.classId) ?? [];
    list.push(booking);
    bookingsByClass.set(booking.classId, list);
  }

  const byClass = scoped.map((klass) => {
    const rows = bookingsByClass.get(klass.id) ?? [];
    const klassAttended = rows.filter((b) => b.status === 'attended').length;
    const klassNoShows = rows.filter((b) => b.status === 'no-show').length;
    const klassConfirmed = rows.filter((b) => b.status === 'booked' || b.status === 'attended').length;
    const resolvedForClass = klassAttended + klassNoShows;
    const uniqueAttendees = classIdsWithAttendance.has(klass.id)
      ? new Set(attendance.filter((a) => a.classId === klass.id).map((a) => a.memberId)).size
      : 0;
    return {
      classId: klass.id,
      className: klass.name,
      startTime: klass.startTime,
      capacity: klass.capacity,
      booked: klassConfirmed,
      attended: uniqueAttendees || klassAttended,
      noShows: klassNoShows,
      cancelled: rows.filter((b) => b.status === 'cancelled').length,
      waitlisted: rows.filter((b) => b.status === 'waitlisted').length,
      fillRate: klass.capacity ? Number((klassConfirmed / klass.capacity).toFixed(3)) : 0,
      attendanceRate: resolvedForClass ? Number((klassAttended / resolvedForClass).toFixed(3)) : 0,
      revenueCents:
        (dropInRevenue(packs, klass.id)) || (uniqueAttendees || klassAttended) * 1800,
    };
  });

  const byInstructor = instructors
    .map((instructor) => {
      const own = scoped.filter((c) => c.instructorId === instructor.id);
      const ownIds = new Set(own.map((c) => c.id));
      const ownBookings = relevant.filter((b) => ownIds.has(b.classId));
      const ownAttended = ownBookings.filter((b) => b.status === 'attended').length;
      const ownResolved = ownBookings.filter((b) => b.status === 'attended' || b.status === 'no-show').length;
      return {
        instructorId: instructor.id,
        name: instructor.name,
        classes: own.length,
        attended: ownAttended,
        attendanceRate: ownResolved ? Number((ownAttended / ownResolved).toFixed(3)) : 0,
      };
    })
    .filter((row) => row.classes > 0)
    .sort((a, b) => b.classes - a.classes);

  return {
    ...range,
    totalBookings: relevant.length,
    attended,
    noShows,
    cancelled: relevant.filter((b) => b.status === 'cancelled').length,
    waitlisted: relevant.filter((b) => b.status === 'waitlisted').length,
    attendanceRate: resolved ? Number((attended / resolved).toFixed(3)) : 0,
    fillRate: capacity ? Number((confirmed / capacity).toFixed(3)) : 0,
    uniqueMembers: await uniqueVisitors(attendance),
    byClass: byClass.sort((a, b) => a.startTime.localeCompare(b.startTime)),
    byInstructor,
  };
}

function dropInRevenue(_packs: unknown[], _classId: string): number {
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export async function dashboardSnapshot(ctx: CoreContext): Promise<DashboardSnapshot> {
  const now = ctx.now();
  const todayStart = startOfDay(now).toISOString();
  const todayEnd = new Date(startOfDay(now).getTime() + DAY_MS - 1).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
  const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const [studio, classes, bookings, attendance, counts, mrr, newThis, newLast, plans] = await Promise.all([
    (async () => {
      const { getStudio } = await import('./studio.js');
      return getStudio(ctx);
    })(),
    todayClasses(ctx),
    ctx.repo.table('bookings').list(),
    listAttendance(ctx, { from: todayStart, to: todayEnd }),
    countByStatus(ctx),
    computeMrr(ctx),
    newMembersBetween(ctx, monthStart, now.toISOString()),
    newMembersBetween(ctx, lastMonthStart, lastMonthEnd),
    listPlans(ctx),
  ]);

  const classIds = new Set(classes.map((c) => c.id));
  const todayBookings = bookings.filter((b) => classIds.has(b.classId));

  const todayClassesView = classes.map((klass) => {
    const rows = todayBookings.filter((b) => b.classId === klass.id);
    return {
      ...klass,
      booked: rows.filter((b) => b.status === 'booked' || b.status === 'attended').length,
      attended: rows.filter((b) => b.status === 'attended').length,
      waitlisted: rows.filter((b) => b.status === 'waitlisted').length,
    };
  });

  const monthRevenue = await revenueReport(ctx, { from: monthStart, to: now.toISOString() });
  const dayRevenue = monthRevenue.byDay.find((point) => point.date === dateOnly(now));

  const upcoming = await listClassesWithCounts(ctx, {
    from: now.toISOString(),
    limit: 8,
    status: 'scheduled',
  });

  const churn = await predictChurn(ctx, { status: 'active', enrich: false });

  const recent = [
    ...attendance
      .slice(0, 6)
      .map((a) => ({
        at: a.checkedInAt,
        kind: 'attendance',
        message: 'Checked in',
      })),
    ...todayBookings
      .filter((b) => b.bookedAt)
      .slice(0, 6)
      .map((b) => ({
        at: b.bookedAt!,
        kind: 'booking',
        message: b.status === 'waitlisted' ? 'Joined a waitlist' : 'New booking',
      })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);

  const capacity = classes.reduce((acc, c) => acc + c.capacity, 0);
  const confirmed = todayBookings.filter((b) => b.status === 'booked' || b.status === 'attended').length;

  return {
    studio: { id: studio.id, name: studio.name, tier: studio.tier, timezone: studio.timezone },
    todayClasses: todayClassesView,
    todayBookings: confirmed,
    todayCheckedIn: attendance.length,
    revenueTodayCents: dayRevenue?.netCents ?? 0,
    revenueMonthCents: monthRevenue.netCents,
    newMembersThisMonth: newThis,
    newMembersLastMonth: newLast,
    activeMembers: counts.active,
    pausedMembers: counts.paused,
    cancelledMembers: counts.cancelled,
    atRiskCount: churn.filter((p) => p.band === 'high' || p.band === 'at-risk').length,
    mrrCents: mrr.mrrCents,
    fillRate: capacity ? Number((confirmed / capacity).toFixed(3)) : 0,
    topClasses: upcoming
      .map((c) => ({
        name: c.name,
        bookings: c.booked,
        fillRate: c.capacity ? Number((c.booked / c.capacity).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.fillRate - a.fillRate)
      .slice(0, 5),
    recentActivity: recent,
  };
}

/** Studio Health Check - the free marketing report. */
export interface HealthCheck {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  headline: string;
  checks: Array<{ label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
  recommendations: string[];
}

export async function studioHealthCheck(ctx: CoreContext): Promise<HealthCheck> {
  const now = ctx.now();
  const last30 = { from: new Date(now.getTime() - 30 * DAY_MS).toISOString(), to: now.toISOString() };
  const [attendance, revenue, counts, upcoming] = await Promise.all([
    attendanceReport(ctx, last30),
    revenueReport(ctx, last30),
    countByStatus(ctx),
    listClassesWithCounts(ctx, { from: now.toISOString(), limit: 20, status: 'scheduled' }),
  ]);

  const checks: HealthCheck['checks'] = [];
  const recommendations: string[] = [];

  const rate = attendance.attendanceRate;
  checks.push({
    label: 'Attendance rate',
    status: rate >= 0.8 ? 'pass' : rate >= 0.65 ? 'warn' : 'fail',
    detail: `${Math.round(rate * 100)}% of bookings were attended over the last 30 days`,
  });
  if (rate < 0.8) recommendations.push('Text members who book and no-show. Most no-shows are schedule clashes, not disengagement.');

  const fill = attendance.fillRate;
  checks.push({
    label: 'Class fill rate',
    status: fill >= 0.7 ? 'pass' : fill >= 0.45 ? 'warn' : 'fail',
    detail: `${Math.round(fill * 100)}% average capacity used`,
  });
  if (fill < 0.6) {
    const emptiest = upcoming
      .filter((c) => c.capacity > 0 && c.booked / c.capacity < 0.4)
      .slice(0, 2)
      .map((c) => c.name);
    if (emptiest.length) recommendations.push(`Add an off-peak class. ${emptiest.join(' and ')} are running under 40% full.`);
  }

  const noShows = attendance.noShows;
  checks.push({
    label: 'No-shows',
    status: noShows <= 3 ? 'pass' : noShows <= 10 ? 'warn' : 'fail',
    detail: `${noShows} no-shows in 30 days`,
  });
  if (noShows > 3) recommendations.push('Introduce a late-cancel fee. It usually halves no-shows within a month.');

  checks.push({
    label: 'Paused members',
    status: counts.paused === 0 ? 'pass' : counts.paused <= 3 ? 'warn' : 'fail',
    detail: `${counts.paused} membership(s) paused`,
  });
  if (counts.paused > 0) recommendations.push('Reach out to paused members - most resumes are a single message away.');

  const overdue = revenue.grossCents > 0 ? 1 : 0;
  void overdue;
  checks.push({
    label: 'Revenue trend',
    status: revenue.netCents > 0 ? 'pass' : 'warn',
    detail: revenue.netCents > 0 ? `Collected ${(revenue.netCents / 100).toFixed(2)} in the last 30 days` : 'No revenue recorded yet',
  });
  if (revenue.netCents === 0) recommendations.push('Connect Stripe or Polar in Settings > Billing so payments land in StudioDesk automatically.');

  const score = Math.round(
    (checks.filter((c) => c.status === 'pass').length * 100 +
      checks.filter((c) => c.status === 'warn').length * 55) /
      checks.length,
  );
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';

  return {
    score,
    grade,
    headline:
      grade === 'A'
        ? 'Your studio is running well. Keep the streak going.'
        : grade === 'B'
          ? 'Solid, with a couple of cheap wins available.'
          : grade === 'C'
            ? 'There is money being left on the table.'
            : 'A few fundamentals need fixing first.',
    checks,
    recommendations: recommendations.slice(0, 4),
  };
}

export { resolveRange as resolveReportRange };
export type { AttendanceReport as AttendanceReportType };
export const reportsPlans = listPlans;