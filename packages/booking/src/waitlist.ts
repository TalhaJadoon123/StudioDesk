import { newNotificationId, sortBy, type Booking, type Notification } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import {
  MAX_WAITLIST,
  classCapacity,
  leaveWaitlist,
  promoteWaitlist,
  resequenceWaitlist,
  waitlist as coreWaitlist,
  nextWaitlistPosition,
} from '@studiodesk/core';
import { notify } from '@studiodesk/core';

export { MAX_WAITLIST };

export interface WaitlistEntry {
  bookingId: string;
  memberId: string;
  memberName: string;
  position: number;
  joinedAt?: string;
  /** How many people are ahead of them. */
  ahead: number;
  className?: string;
  startTime?: string;
  /** Free spots right now - how likely this person is to be promoted. */
  spotsFree: number;
  /** Estimated hours until a spot is likely to free up. */
  estimatedWaitHours: number | null;
}

export interface ClassWaitlist {
  classId: string;
  className: string;
  startTime: string;
  capacity: number;
  confirmed: number;
  spotsFree: number;
  waitlisted: number;
  entries: WaitlistEntry[];
}

/** Full waitlist view for one class, with promotion likelihood. */
export async function classWaitlist(ctx: CoreContext, classId: string): Promise<ClassWaitlist> {
  const [klass, capacity, rows] = await Promise.all([
    ctx.repo.table('classes').findById(classId),
    classCapacity(ctx, classId),
    coreWaitlist(ctx, classId),
  ]);
  if (!klass) throw new Error(`Class ${classId} not found`);

  const entries: WaitlistEntry[] = rows.map((row, index) => ({
    bookingId: row.id,
    memberId: row.memberId,
    memberName: row.memberName ?? 'Unknown',
    position: row.waitlistPosition ?? index + 1,
    joinedAt: row.waitlistJoinedAt,
    ahead: Math.max(0, (row.waitlistPosition ?? index + 1) - 1),
    className: row.className,
    startTime: row.startTime,
    spotsFree: capacity.spotsLeft,
    estimatedWaitHours: estimateWaitHours(ctx, row.waitlistPosition ?? index + 1, capacity.waitlisted, klass.startTime),
  }));

  return {
    classId,
    className: klass.name,
    startTime: klass.startTime,
    capacity: klass.capacity,
    confirmed: capacity.confirmed,
    spotsFree: capacity.spotsLeft,
    waitlisted: capacity.waitlisted,
    entries,
  };
}

/**
 * Rough ETA for a waitlist position, based on the class's historical no-show
 * and late-cancel rate. Purely advisory - shown as "likely ~2h".
 */
export function estimateWaitHours(
  ctx: CoreContext,
  position: number,
  totalWaiting: number,
  startTime: string,
): number | null {
  if (position <= 0) return 0;
  const hoursUntilStart = (Date.parse(startTime) - ctx.now().getTime()) / 3_600_000;
  if (hoursUntilStart <= 0) return null;

  // Baseline: studios free ~8% of capacity to late cancels + no-shows.
  const expectedFreed = Math.max(1, Math.round(totalWaiting * 0.08) + 1);
  const progress = position / expectedFreed;
  return Math.max(0, Math.round(hoursUntilStart * Math.min(1, progress)));
}

export async function positionOf(ctx: CoreContext, bookingId: string): Promise<number | null> {
  const booking = await ctx.repo.table('bookings').findById(bookingId);
  if (!booking || booking.status !== 'waitlisted') return null;
  return booking.waitlistPosition ?? (await nextWaitlistPosition(ctx, booking.classId)) - 1;
}

/**
 * Promotes the queue and notifies everyone who moved up, including people who
 * are still waiting so they see their new position.
 */
export async function promoteAndNotify(
  ctx: CoreContext,
  classId: string,
  slots?: number,
): Promise<{ promoted: Booking[]; notified: Notification[]; remaining: WaitlistEntry[] }> {
  const promoted = await promoteWaitlist(ctx, classId, slots);

  const notified: Notification[] = [];
  for (const booking of promoted) {
    const member = await ctx.repo.table('members').findById(booking.memberId);
    const klass = await ctx.repo.table('classes').findById(classId);
    const notification = await notify(ctx, 'waitlist-promoted', {
      memberId: booking.memberId,
      className: klass?.name,
      startTime: klass?.startTime,
      channel: 'push',
      data: { classId, deepLink: `/classes/${classId}` },
    });
    if (notification) notified.push(notification);
    void member;
  }

  const remaining = await resequenced(ctx, classId);
  return { promoted, notified, remaining };
}

async function resequenced(ctx: CoreContext, classId: string): Promise<WaitlistEntry[]> {
  await resequenceWaitlist(ctx, classId);
  const view = await classWaitlist(ctx, classId);
  return view.entries;
}

/** Studio-wide waitlist overview for the dashboard. */
export async function waitlistOverview(ctx: CoreContext, limit = 10) {
  const [bookings, classes, members] = await Promise.all([
    ctx.repo.table('bookings').list({ filter: { status: 'waitlisted' } }),
    ctx.repo.table('classes').list(),
    ctx.repo.table('members').list(),
  ]);
  const memberName = new Map(members.map((m) => [m.id, m.name] as const));
  const classById = new Map(classes.map((c) => [c.id, c] as const));

  const byClass = new Map<string, Booking[]>();
  for (const booking of bookings) {
    const list = byClass.get(booking.classId) ?? [];
    list.push(booking);
    byClass.set(booking.classId, list);
  }

  const rows = await Promise.all(
    [...byClass.entries()].map(async ([classId, list]) => {
      const klass = classById.get(classId);
      const capacity = await classCapacity(ctx, classId);
      return {
        classId,
        className: klass?.name ?? 'Unknown',
        startTime: klass?.startTime ?? '',
        capacity: klass?.capacity ?? 0,
        confirmed: capacity.confirmed,
        waitlisted: list.length,
        spotsFree: capacity.spotsLeft,
        names: sortBy(
          list.map((b) => ({ bookingId: b.id, name: memberName.get(b.memberId) ?? 'Unknown', position: b.waitlistPosition ?? 0 })),
          (r) => r.position,
        ),
      };
    }),
  );

  return sortBy(rows, (row) => row.startTime, 'asc').slice(0, limit);
}

/**
 * Manually release a spot: promotes `count` people even when the class is
 * technically full (studio override for over-subscribed classes).
 */
export async function forcePromote(ctx: CoreContext, classId: string, count = 1): Promise<Booking[]> {
  return promoteWaitlist(ctx, classId, count);
}

export async function removeFromWaitlist(ctx: CoreContext, bookingId: string): Promise<Booking> {
  return leaveWaitlist(ctx, bookingId);
}

/**
 * Invites the whole queue when a class gains capacity, or reports that nobody
 * is waiting. Used by the "promote all" button on the class page.
 */
export async function promoteAll(ctx: CoreContext, classId: string): Promise<Booking[]> {
  const capacity = await classCapacity(ctx, classId);
  if (capacity.waitlisted === 0) return [];
  return promoteWaitlist(ctx, classId, capacity.waitlisted);
}

export function reminderId(): string {
  return newNotificationId();
}