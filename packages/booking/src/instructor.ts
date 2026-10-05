import { DAY_MS, addMinutes, sortBy, type Class, type Instructor } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { listInstructors } from '@studiodesk/core';
import { findConflicts } from './calendar.js';

export interface InstructorLoad {
  instructor: Instructor;
  window: { from: string; to: string };
  classesHeld: number;
  classesUpcoming: number;
  distinctMembers: number;
  bookedSeats: number;
  capacity: number;
  utilization: number;
  averageAttendance: number;
  teachingHours: number;
  revenueAttributedCents: number;
  dayPattern: Array<{ weekday: string; classes: number; hours: number }>;
  peakHour: number | null;
  conflicts: Array<{ a: Class; b: Class }>;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Total minutes an instructor teaches on a given weekday (0 = Monday). */
function rowsFor(classes: Class[], weekdayIndex: number): { count: number; minutes: number } {
  const rows = classes.filter((c) => ((new Date(c.startTime).getUTCDay() + 6) % 7) === weekdayIndex);
  return {
    count: rows.length,
    minutes: rows.reduce((acc, c) => acc + (c.durationMinutes ?? 60), 0),
  };
}

/** Everything the instructor tab needs in one call. */
export async function instructorLoad(
  ctx: CoreContext,
  instructorId: string,
  window: { from: string | Date; to: string | Date },
): Promise<InstructorLoad> {
  const instructor = await ctx.repo.table('instructors').findById(instructorId);
  if (!instructor) throw new Error(`Instructor ${instructorId} not found`);

  const fromIso = new Date(window.from).toISOString();
  const toIso = new Date(window.to).toISOString();

  const [classes, bookings, attendance, dropIns] = await Promise.all([
    ctx.repo.table('classes').list({ filter: { instructorId, from: fromIso, to: toIso }, limit: 1000 }),
    ctx.repo.table('bookings').list(),
    ctx.repo.table('attendance').list(),
    ctx.repo.table('dropIns').list(),
  ]);

  const classIds = new Set(classes.map((c) => c.id));
  const relevant = bookings.filter((b) => classIds.has(b.classId));
  const attendedBookingIds = new Set(
    attendance.filter((a) => classIds.has(a.classId)).map((a) => a.bookingId).filter(Boolean) as string[],
  );

  const bookedSeats = relevant.filter((b) => b.status === 'booked' || b.status === 'attended').length;
  const capacity = classes.reduce((acc, c) => acc + c.capacity, 0);
  const attendedCount = attendedBookingIds.size;
  const resolved = relevant.filter((b) => b.status === 'attended' || b.status === 'no-show').length;

  const dayPattern = WEEKDAYS.map((weekday, index) => ({
    weekday,
    classes: rowsFor(classes, index).count,
    hours: Number((rowsFor(classes, index).minutes / 60).toFixed(1)),
  }));

  const hourCounts = new Map<number, number>();
  for (const klass of classes) {
    const hour = Number(klass.startTime.slice(11, 13));
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }
  const peakHour = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const conflicts = await findConflicts(
    ctx,
    classes.filter((c) => c.status === 'scheduled'),
  );

  const nowMs = ctx.now().getTime();
  const dropInCents = dropIns
    .filter((d) => classIds.has(d.classId) && d.status === 'active')
    .reduce((acc, d) => acc + d.priceCents, 0);

  return {
    instructor,
    window: { from: fromIso, to: toIso },
    classesHeld: classes.length,
    classesUpcoming: classes.filter((c) => Date.parse(c.startTime) > nowMs).length,
    distinctMembers: new Set(relevant.map((b) => b.memberId)).size,
    bookedSeats,
    capacity,
    utilization: capacity ? Number((bookedSeats / capacity).toFixed(3)) : 0,
    averageAttendance: resolved ? Number((attendedCount / resolved).toFixed(3)) : 0,
    teachingHours: Number((classes.reduce((acc, c) => acc + (c.durationMinutes ?? 60), 0) / 60).toFixed(1)),
    revenueAttributedCents: dropInCents + attendedCount * 1800,
    dayPattern,
    peakHour,
    conflicts,
  };
}

/** Roster of every instructor with their headline numbers. */
export async function instructorRoster(ctx: CoreContext, windowDays = 30) {
  const instructors = await listInstructors(ctx, { activeOnly: true });
  const now = ctx.now();
  const from = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const to = new Date(now.getTime() + windowDays * DAY_MS).toISOString();
  const rows = await Promise.all(
    instructors.map((instructor) =>
      instructorLoad(ctx, instructor.id, { from, to }).catch(() => null),
    ),
  );
  return sortBy(
    rows.filter((row): row is InstructorLoad => Boolean(row)),
    (row) => row.classesHeld,
    'desc',
  );
}

export interface InstructorAvailabilitySlot {
  startTime: string;
  endTime: string;
  available: boolean;
  reason?: 'booked' | 'travel-buffer' | 'outside-hours';
}

/**
 * Suggestion list for scheduling: the next N free slots for an instructor,
 * respecting a 30 minute travel buffer between classes.
 */
export async function suggestSlots(
  ctx: CoreContext,
  instructorId: string,
  options: { days?: number; dayStartHour?: number; dayEndHour?: number; durationMinutes?: number } = {},
): Promise<InstructorAvailabilitySlot[]> {
  const days = options.days ?? 14;
  const dayStartHour = options.dayStartHour ?? 6;
  const dayEndHour = options.dayEndHour ?? 21;
  const duration = options.durationMinutes ?? 60;
  const bufferMinutes = 30;

  const now = ctx.now();
  const from = now.toISOString();
  const to = new Date(now.getTime() + days * DAY_MS).toISOString();
  const existing = await ctx.repo
    .table('classes')
    .list({ filter: { instructorId, from, to }, limit: 1000 });

  const slots: InstructorAvailabilitySlot[] = [];
  for (let day = 0; day < days; day += 1) {
    const base = new Date(now.getTime() + day * DAY_MS);
    for (let hour = dayStartHour; hour <= dayEndHour - duration / 60; hour += 1) {
      const start = new Date(base.getTime());
      start.setUTCHours(hour, 0, 0, 0);
      if (start.getTime() < now.getTime()) continue;
      const end = addMinutes(start, duration);

      const clash = existing.find((klass) => {
        const klassStart = Date.parse(klass.startTime);
        const klassEnd = Date.parse(
          klass.endTime ?? addMinutes(klass.startTime, klass.durationMinutes ?? 60).toISOString(),
        );
        const bufferedStart = klassStart - bufferMinutes * 60_000;
        const bufferedEnd = klassEnd + bufferMinutes * 60_000;
        return start.getTime() < bufferedEnd && bufferedStart < end.getTime();
      });

      slots.push({
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        available: !clash,
        reason: clash ? 'booked' : undefined,
      });
    }
  }
  return slots;
}

/** Detects instructors who are over-scheduled in the same week. */
export async function overbookedInstructors(
  ctx: CoreContext,
  maxPerWeek = 12,
): Promise<Array<{ instructorId: string; name: string; weekStart: string; classes: number }>> {
  const instructors = await listInstructors(ctx);
  const classes = await ctx.repo.table('classes').list({
    filter: {
      from: ctx.now().toISOString(),
      to: new Date(ctx.now().getTime() + 28 * DAY_MS).toISOString(),
      status: 'scheduled',
    },
    limit: 1000,
  });

  const out: Array<{ instructorId: string; name: string; weekStart: string; classes: number }> = [];
  for (const instructor of instructors) {
    const own = classes.filter((c) => c.instructorId === instructor.id);
    const byWeek = new Map<string, number>();
    for (const klass of own) {
      const date = new Date(klass.startTime);
      const monday = new Date(date.getTime());
      monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      const key = monday.toISOString().slice(0, 10);
      byWeek.set(key, (byWeek.get(key) ?? 0) + 1);
    }
    for (const [weekStart, count] of byWeek) {
      if (count > maxPerWeek) {
        out.push({ instructorId: instructor.id, name: instructor.name, weekStart, classes: count });
      }
    }
  }
  return out.sort((a, b) => b.classes - a.classes);
}

/** Which classes a member has taken with an instructor. */
export async function memberHistoryWithInstructor(
  ctx: CoreContext,
  instructorId: string,
  memberId: string,
) {
  const classes = await ctx.repo.table('classes').list({ filter: { instructorId }, limit: 1000 });
  const classIds = new Set(classes.map((c) => c.id));
  const bookings = (
    await ctx.repo.table('bookings').list({ filter: { memberId }, limit: 1000 })
  ).filter((b) => classIds.has(b.classId));

  return sortBy(
    bookings.map((booking) => {
      const klass = classes.find((c) => c.id === booking.classId)!;
      return {
        bookingId: booking.id,
        classId: klass.id,
        className: klass.name,
        startTime: klass.startTime,
        status: booking.status,
      };
    }),
    (row) => row.startTime,
    'desc',
  );
}