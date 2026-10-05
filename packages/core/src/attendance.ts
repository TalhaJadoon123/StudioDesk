import {
  AppError,
  DAY_MS,
  addMinutes,
  conflict,
  newAttendanceId,
  notFound,
  sortBy,
  type Attendance,
  type AttendanceSummary,
  type Booking,
  type CheckinMethod,
  type Class,
  type Member,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { getStudioSettings } from './studio.js';
import { markAttended } from './bookings.js';

export function attendanceRepo(ctx: CoreContext) {
  return ctx.repo.table('attendance');
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

export interface RecordAttendanceInput {
  memberId: string;
  bookingId?: string;
  classId?: string;
  method: CheckinMethod;
  checkedInAt?: string;
  lateByMinutes?: number;
  latitude?: number;
  longitude?: number;
  distanceMeters?: number;
  deviceId?: string;
  staffId?: string;
}

/**
 * Records a check-in. Idempotent per (member, class): a second scan on the same
 * day returns the original record instead of double-counting attendance.
 */
export async function recordAttendance(
  ctx: CoreContext,
  input: RecordAttendanceInput,
): Promise<{ attendance: Attendance; duplicate: boolean; booking?: Booking }> {
  const member = await ctx.repo.table('members').findById(input.memberId);
  if (!member) throw notFound('Member', input.memberId);

  let booking: Booking | undefined;
  if (input.bookingId) {
    booking = (await ctx.repo.table('bookings').findById(input.bookingId)) ?? undefined;
    if (!booking) throw notFound('Booking', input.bookingId);
  } else if (input.classId) {
    booking = (await ctx.repo.table('bookings').findOne({
                                                 filter: {
      memberId: input.memberId,
      classId: input.classId,
      $or: [{ status: 'booked' }, { status: 'attended' }],
    
                                               },
                                               } as never)) ?? undefined;
  }

  const duplicateOf = await attendanceRepo(ctx).findOne({
                                                 filter: {
    memberId: input.memberId,
    ...(input.classId ? { classId: input.classId } : {}),
    ...(booking && !input.classId ? { bookingId: booking.id } : {}),
  
                                               },
                                               });
  if (duplicateOf) return { attendance: duplicateOf, duplicate: true, booking };

  const settings = await getStudioSettings(ctx);
  const at = input.checkedInAt ?? ctx.now().toISOString();
  let lateByMinutes = input.lateByMinutes ?? 0;

  if (booking?.classId || input.classId) {
    const klass = await ctx.repo.table('classes').findById(input.classId ?? booking!.classId);
    if (klass) {
      const opens = addMinutes(klass.startTime, -(Number(settings.checkinOpensMinutesBefore) ?? 30)).toISOString();
      const closes = addMinutes(klass.startTime, Number(settings.checkinClosesMinutesAfter) ?? 15).toISOString();
      if (Date.parse(at) < Date.parse(opens)) lateByMinutes = -Math.round((Date.parse(opens) - Date.parse(at)) / 60000);
      if (Date.parse(at) > Date.parse(closes)) lateByMinutes = Math.round((Date.parse(at) - Date.parse(klass.startTime)) / 60000);
    }
  }

  const attendance = await attendanceRepo(ctx).insert({
    id: newAttendanceId(),
    memberId: input.memberId,
    classId: input.classId ?? booking?.classId ?? '',
    bookingId: booking?.id,
    method: input.method,
    checkedInAt: at,
    lateByMinutes,
    latitude: input.latitude,
    longitude: input.longitude,
    distanceMeters: input.distanceMeters,
    deviceId: input.deviceId,
    staffId: input.staffId,
    createdAt: at,
  });

  if (booking) await markAttended(ctx, booking.id);

  await ctx.events.emit('attendance.recorded', {
    attendanceId: attendance.id,
    memberId: input.memberId,
    classId: attendance.classId,
    method: input.method,
  });
  return { attendance, duplicate: false, booking };
}

/** Staff walk-in: creates a booking then checks the member in. */
export async function walkIn(
  ctx: CoreContext,
  input: { memberId: string; classId: string; staffId?: string },
): Promise<{ attendance: Attendance; booking: Booking; duplicate: boolean }> {
  const klass = await ctx.repo.table('classes').findById(input.classId);
  if (!klass) throw notFound('Class', input.classId);
  if (klass.status === 'cancelled') throw conflict('That class was cancelled');

  const existing = await ctx.repo.table('bookings').findOne({
                                                     filter: {
    memberId: input.memberId,
    classId: input.classId,
    $or: [{ status: 'booked' }, { status: 'attended' }],
  
                                                   },
                                                   } as never);

  let booking = existing ?? undefined;
  if (!booking) {
    const { createBooking } = await import('./bookings.js');
    const result = await createBooking(ctx, {
      memberId: input.memberId,
      classId: input.classId,
      source: 'staff',
      override: true,
      byStaff: true,
    });
    booking = result.booking;
  }
  if (!booking) throw new AppError('internal_error', 'Could not create a booking for the walk-in');

  const result = await recordAttendance(ctx, {
    memberId: input.memberId,
    classId: input.classId,
    bookingId: booking.id,
    method: 'manual',
    staffId: input.staffId,
  });
  return { attendance: result.attendance, booking, duplicate: result.duplicate };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export interface ListAttendanceQuery {
  memberId?: string;
  classId?: string;
  method?: CheckinMethod;
  from?: string | Date;
  to?: string | Date;
  limit?: number;
}

const isoOf = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export async function listAttendance(
  ctx: CoreContext,
  query: ListAttendanceQuery = {},
): Promise<Attendance[]> {
  const filter: Record<string, unknown> = {};
  if (query.memberId) filter.memberId = query.memberId;
  if (query.classId) filter.classId = query.classId;
  if (query.method) filter.method = query.method;
  if (query.from) filter.checkedInAt = { $gte: isoOf(query.from) };
  if (query.to) filter.checkedInAt = { $lte: isoOf(query.to) };
  const rows = await attendanceRepo(ctx).list({ filter: filter as never, order: { field: 'checkedInAt', dir: 'desc' } });
  return query.limit ? rows.slice(0, query.limit) : rows;
}

export async function memberAttendance(
  ctx: CoreContext,
  memberId: string,
  limit?: number,
): Promise<Attendance[]> {
  return listAttendance(ctx, { memberId, limit });
}

export async function classAttendance(ctx: CoreContext, classId: string): Promise<Attendance[]> {
  return attendanceRepo(ctx).list({ filter: { classId } });
}

export async function visitsInRange(ctx: CoreContext, fromIso: string, toIso: string): Promise<Attendance[]> {
  return attendanceRepo(ctx).list({
    filter: { checkedInAt: { $gte: fromIso, $lte: toIso } },
  });
}

export async function uniqueVisitors(attendance: Attendance[]): Promise<number> {
  return new Set(attendance.map((a) => a.memberId)).size;
}

/** Consecutive-day streak ending today (or yesterday). */
export async function visitStreak(ctx: CoreContext, memberId: string): Promise<number> {
  const rows = await attendanceRepo(ctx).list({ filter: { memberId } });
  const days = new Set(rows.map((a) => a.checkedInAt.slice(0, 10)));
  let streak = 0;
  const cursor = new Date(ctx.now());
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setTime(cursor.getTime() - DAY_MS);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setTime(cursor.getTime() - DAY_MS);
  }
  return streak;
}

/* -------------------------------------------------------------------------- */
/* Summaries                                                                  */
/* -------------------------------------------------------------------------- */

export async function classSummary(ctx: CoreContext, klass: Class): Promise<AttendanceSummary> {
  const [bookings, attendance] = await Promise.all([
    ctx.repo.table('bookings').list({ filter: { classId: klass.id } }),
    classAttendance(ctx, klass.id),
  ]);
  const booked = bookings.filter((b) => b.status === 'booked' || b.status === 'attended').length;
  const attendedCount = bookings.filter((b) => b.status === 'attended').length;
  const noShows = bookings.filter((b) => b.status === 'no-show').length;
  const cancelled = bookings.filter((b) => b.status === 'cancelled').length;
  const waitlisted = bookings.filter((b) => b.status === 'waitlisted').length;
  const resolved = attendedCount + noShows;

  // Attendees who were not on a booking (walk-ins) still count as attendance.
  const uniqueAttendees = new Set(attendance.map((a) => a.memberId)).size;

  return {
    classId: klass.id,
    className: klass.name,
    startTime: klass.startTime,
    capacity: klass.capacity,
    booked,
    attended: uniqueAttendees,
    noShows,
    cancelled,
    waitlisted,
    fillRate: klass.capacity ? Number((booked / klass.capacity).toFixed(3)) : 0,
    attendanceRate: resolved ? Number((attendedCount / resolved).toFixed(3)) : uniqueAttendees ? 1 : 0,
    revenueCents: attendedCount * (klass.creditCost ?? 1) * 0,
  };
}

export async function attendanceSummaries(
  ctx: CoreContext,
  fromIso: string,
  toIso: string,
): Promise<AttendanceSummary[]> {
  const classes = await ctx.repo.table('classes').list({
    filter: { startTime: { $gte: fromIso, $lte: toIso } },
  });
  return Promise.all(sortBy(classes, (c) => c.startTime, 'asc').map((klass) => classSummary(ctx, klass)));
}

export async function attendanceRateForRange(ctx: CoreContext, fromIso: string, toIso: string) {
  const [bookings, classes] = await Promise.all([
    ctx.repo.table('bookings').list(),
    ctx.repo.table('classes').list({ filter: { startTime: { $gte: fromIso, $lte: toIso } } }),
  ]);
  const classIds = new Set(classes.map((c) => c.id));
  const relevant = bookings.filter((b) => classIds.has(b.classId));
  const attended = relevant.filter((b) => b.status === 'attended').length;
  const noShows = relevant.filter((b) => b.status === 'no-show').length;
  const resolved = attended + noShows;
  const capacity = classes.reduce((acc, c) => acc + c.capacity, 0);
  const confirmed = relevant.filter((b) => b.status === 'booked' || b.status === 'attended').length;
  return {
    totalBookings: relevant.length,
    attended,
    noShows,
    cancelled: relevant.filter((b) => b.status === 'cancelled').length,
    waitlisted: relevant.filter((b) => b.status === 'waitlisted').length,
    attendanceRate: resolved ? Number((attended / resolved).toFixed(3)) : 0,
    fillRate: capacity ? Number((confirmed / capacity).toFixed(3)) : 0,
    uniqueMembers: uniqueVisitors(await visitsInRange(ctx, fromIso, toIso)),
    classesHeld: classes.length,
  };
}

export function lastVisit(attendance: Attendance[]): string | null {
  return attendance.map((a) => a.checkedInAt).sort().at(-1) ?? null;
}

export async function removeAttendance(ctx: CoreContext, id: string): Promise<boolean> {
  return attendanceRepo(ctx).remove(id);
}

export type { Member };