import {
  DAY_MS,
  addDays,
  addMinutes,
  dateOnly,
  startOfDay,
  weekdayIndex,
  WEEKDAY_NAMES,
  type Class,
  type Instructor,
} from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { classCapacity, listClassesWithCounts, type ClassView } from '@studiodesk/core';
import { describeRRule, expandOccurrences } from './recurring.js';

export type { ClassView };

const isoOf = (value: string | Date | undefined): string =>
  value instanceof Date ? value.toISOString() : new Date(value ?? Date.now()).toISOString();

export interface CalendarQuery {
  from: string | Date;
  to: string | Date;
  instructorId?: string;
  classType?: string;
  /** Only include classes that still have room. */
  onlyAvailable?: boolean;
  includePast?: boolean;
}

export interface CalendarEntry extends ClassView {
  dayKey: string;
  weekdayName: string;
  timeLabel: string;
  seriesLabel?: string;
}

export interface CalendarDay {
  date: string;
  weekday: number;
  weekdayName: string;
  isToday: boolean;
  entries: CalendarEntry[];
  totals: { classes: number; spotsLeft: number; waitlisted: number };
}

export interface Calendar {
  from: string;
  to: string;
  days: CalendarDay[];
  classes: CalendarEntry[];
  summary: {
    totalClasses: number;
    totalSpotsLeft: number;
    totalWaitlisted: number;
    averageFillRate: number;
    busiestDay?: string;
  };
}

function timeLabel(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

/** Day-by-day calendar with live capacity. Powers /schedule and the mobile app. */
export async function buildCalendar(ctx: CoreContext, query: CalendarQuery): Promise<Calendar> {
  const from = startOfDay(query.from);
  const to = startOfDay(query.to);
  const classes = await listClassesWithCounts(ctx, {
    from: from.toISOString(),
    to: addDays(to, 1).toISOString(),
    instructorId: query.instructorId,
    classType: query.classType,
  });

  const nowIso = ctx.now().toISOString();
  const filtered = classes.filter((klass) => {
    if (klass.status === 'cancelled') return false;
    if (query.includePast === false && klass.startTime < nowIso) return false;
    if (query.onlyAvailable && klass.spotsLeft <= 0) return false;
    return true;
  });

  const entries: CalendarEntry[] = filtered.map((klass) => ({
    ...klass,
    dayKey: dateOnly(klass.startTime),
    weekdayName: WEEKDAY_NAMES[weekdayIndex(klass.startTime)]!,
    timeLabel: timeLabel(klass.startTime),
    seriesLabel: klass.rrule ? describeRRule(klass.rrule) : undefined,
  }));

  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const list = byDay.get(entry.dayKey) ?? [];
    list.push(entry);
    byDay.set(entry.dayKey, list);
  }

  const totalDays = Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  const today = dateOnly(ctx.now());
  const days: CalendarDay[] = [];
  for (let i = 0; i <= totalDays; i += 1) {
    const date = addDays(from, i);
    const key = dateOnly(date);
    const dayEntries = (byDay.get(key) ?? []).sort((a, b) => a.startTime.localeCompare(b.startTime));
    days.push({
      date: key,
      weekday: weekdayIndex(date),
      weekdayName: WEEKDAY_NAMES[weekdayIndex(date)]!,
      isToday: key === today,
      entries: dayEntries,
      totals: {
        classes: dayEntries.length,
        spotsLeft: dayEntries.reduce((acc, e) => acc + e.spotsLeft, 0),
        waitlisted: dayEntries.reduce((acc, e) => acc + e.waitlisted, 0),
      },
    });
  }

  const totalSpotsLeft = entries.reduce((acc, e) => acc + e.spotsLeft, 0);
  const filled = entries.reduce((acc, e) => acc + e.booked, 0);
  const capacity = entries.reduce((acc, e) => acc + e.capacity, 0);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    classes: entries,
    summary: {
      totalClasses: entries.length,
      totalSpotsLeft,
      totalWaitlisted: entries.reduce((acc, e) => acc + e.waitlisted, 0),
      averageFillRate: capacity ? Number((filled / capacity).toFixed(3)) : 0,
      busiestDay: days.reduce<string | undefined>(
        (best, day) => (day.totals.classes > (best ? (byDay.get(best)?.length ?? 0) : 0) ? day.date : best),
        undefined,
      ),
    },
  };
}

/** Monday-first week grid, which is what the schedule page renders. */
export async function buildWeekGrid(
  ctx: CoreContext,
  anchor: string | Date,
  options: { instructorId?: string; classType?: string } = {},
): Promise<Calendar> {
  const anchorDate = startOfDay(anchor);
  // `weekdayIndex` is already Monday-first, so no extra offset is needed.
  const monday = addDays(anchorDate, -weekdayIndex(anchorDate));
  return buildCalendar(ctx, { from: monday, to: addDays(monday, 6), ...options });
}

export async function buildMonthGrid(
  ctx: CoreContext,
  anchor: string | Date,
  options: { instructorId?: string; classType?: string } = {},
): Promise<Calendar> {
  const date = new Date(startOfDay(anchor).getTime());
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const start = addDays(first, -weekdayIndex(first));
  return buildCalendar(ctx, { from: start, to: addDays(start, 41), ...options });
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                */
/* -------------------------------------------------------------------------- */

export interface AvailabilityQuery {
  from: string | Date;
  to: string | Date;
  instructorIds?: string[];
  minSpots?: number;
  /** Only classes inside these hours (0-23). */
  fromHour?: number;
  toHour?: number;
}

export async function findAvailability(ctx: CoreContext, query: AvailabilityQuery): Promise<CalendarEntry[]> {
  const calendar = await buildCalendar(ctx, { from: query.from, to: query.to, includePast: false });
  const minSpots = query.minSpots ?? 1;
  return calendar.classes.filter((entry) => {
    if (entry.spotsLeft < minSpots) return false;
    if (query.instructorIds?.length && !query.instructorIds.includes(entry.instructorId)) return false;
    const hour = Number(entry.startTime.slice(11, 13));
    if (query.fromHour !== undefined && hour < query.fromHour) return false;
    if (query.toHour !== undefined && hour > query.toHour) return false;
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Series                                                                     */
/* -------------------------------------------------------------------------- */

export interface SeriesPreview {
  rrule: string;
  description: string;
  occurrences: Array<{ startTime: string; endTime: string; date: string; time: string }>;
  count: number;
  conflicts: Array<{ startTime: string; instructorId: string; name: string }>;
}

/**
 * Previews a recurring series before committing it: expands the rule, checks
 * the instructor for clashes and flags collisions with existing classes.
 */
export async function previewSeries(
  ctx: CoreContext,
  input: {
    rrule: string;
    instructorId: string;
    durationMinutes: number;
    from?: string | Date;
    to?: string | Date;
    name?: string;
    capacity?: number;
  },
): Promise<SeriesPreview> {
  const to = input.to ?? addDays(ctx.now(), 90);
  const from = input.from ?? ctx.now();
  // No `from` cutoff is passed to the expander: a rule may legitimately start
  // before today (we still want to know where it has got to), and the caller's
  // own filter below decides which occurrences are worth creating.
  const occurrences = expandOccurrences(input.rrule, {
    from: phaseAnchor(input.rrule, from),
    to,
    durationMinutes: input.durationMinutes,
    limit: 400,
  });

  // `classes` stores its time in `startTime`, so the range filter must target
  // that field (a bare `from`/`to` would match nothing and silently report
  // zero conflicts).
  const existing = await ctx.repo.table('classes').list({
    filter: {
      instructorId: input.instructorId,
      startTime: { $gte: isoOf(from), $lte: isoOf(to) },
      status: { $ne: 'cancelled' },
    },
    limit: 1000,
  });

  // Only occurrences from the requested window onwards are relevant.
  const relevant = occurrences.filter((o) => Date.parse(o.startTime) >= new Date(from).getTime());

  const conflicts: SeriesPreview['conflicts'] = [];
  for (const occurrence of relevant) {
    const clash = existing.find((klass) => overlaps(occurrence.startTime, occurrence.endTime, klass));
    if (clash) {
      conflicts.push({ startTime: occurrence.startTime, instructorId: input.instructorId, name: clash.name });
    }
  }

  const { describeRRule } = await import('./recurring.js');
  return {
    rrule: input.rrule,
    description: describeRRule(input.rrule),
    occurrences: relevant.map((o) => ({
      startTime: o.startTime,
      endTime: o.endTime,
      date: dateOnly(o.startTime),
      time: o.startTime.slice(11, 16),
    })),
    count: relevant.length,
    conflicts,
  };
}

/**
 * The rule's own DTSTART when it has one, otherwise `fallback`. Keeps the
 * expansion anchored correctly for fortnightly/monthly rules.
 */
function phaseAnchor(rrule: string, fallback: string | Date): string {
  const match = /DTSTART:?([0-9TZ]+)/i.exec(rrule);
  if (match?.[1]) return match[1];
  return fallback instanceof Date ? fallback.toISOString() : fallback;
}

/** Creates every class in a series. Returns the created classes. */
export async function createSeries(
  ctx: CoreContext,
  input: {
    name: string;
    instructorId: string;
    rrule: string;
    durationMinutes: number;
    capacity: number;
    from: string | Date;
    to?: string | Date;
    room?: string;
    color?: string;
    classType?: string;
    creditCost?: number;
    level?: Class['level'];
    lateCancelHours?: number;
    /** Skip occurrences that clash with an existing class. */
    skipConflicts?: boolean;
  },
): Promise<{ created: Class[]; skipped: number }> {
  const preview = await previewSeries(ctx, {
    rrule: input.rrule,
    instructorId: input.instructorId,
    durationMinutes: input.durationMinutes,
    from: input.from,
    to: input.to,
    name: input.name,
  });

  const { createClass } = await import('@studiodesk/core');
  const clashTimes = new Set(preview.conflicts.map((c) => c.startTime));
  const created: Class[] = [];
  let skipped = 0;

  // Never create a class in the past.
    const nowMs = ctx.now().getTime();
  for (const occurrence of preview.occurrences) {
    if (Date.parse(occurrence.startTime) < nowMs) {
      skipped += 1;
      continue;
    }
    if (input.skipConflicts !== false && clashTimes.has(occurrence.startTime)) {
      skipped += 1;
      continue;
    }
    created.push(
      await createClass(ctx, {
        name: input.name,
        instructorId: input.instructorId,
        startTime: occurrence.startTime,
        endTime: occurrence.endTime,
        capacity: input.capacity,
        room: input.room,
        color: input.color,
        classType: input.classType ?? input.name,
        creditCost: input.creditCost,
        level: input.level,
        lateCancelHours: input.lateCancelHours,
        rrule: input.rrule,
      }),
    );
  }
  return { created, skipped };
}

/** Deletes the future classes belonging to one series. */
export async function cancelSeries(
  ctx: CoreContext,
  seriesId: string,
  reason = 'Series ended',
): Promise<number> {
  const { cancelClass } = await import('@studiodesk/core');
  const classes = await ctx.repo.table('classes').list({ filter: { seriesId } });
  let cancelled = 0;
  for (const klass of classes) {
    if (Date.parse(klass.startTime) < ctx.now().getTime()) continue;
    if (klass.status === 'cancelled') continue;
    await cancelClass(ctx, klass.id, reason);
    cancelled += 1;
  }
  return cancelled;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function overlaps(startA: string, endA: string, klass: Class): boolean {
  const aStart = Date.parse(startA);
  const aEnd = Date.parse(endA);
  const bStart = Date.parse(klass.startTime);
  const bEnd = Date.parse(klass.endTime ?? addMinutes(klass.startTime, klass.durationMinutes ?? 60).toISOString());
  return aStart < bEnd && bStart < aEnd;
}

/** Detects instructor double-booking across the whole timetable. */
export async function findConflicts(ctx: CoreContext, classes: Class[]): Promise<Array<{ a: Class; b: Class }>> {
  const conflicts: Array<{ a: Class; b: Class }> = [];
  const sorted = [...classes].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.instructorId !== b.instructorId) continue;
      if (Date.parse(b.startTime) > Date.parse(a.endTime ?? addMinutes(a.startTime, a.durationMinutes ?? 60).toISOString())) {
        break;
      }
      conflicts.push({ a, b });
    }
  }
  return conflicts;
}

export async function dayCapacity(ctx: CoreContext, classId: string) {
  return classCapacity(ctx, classId);
}

export type { Instructor };