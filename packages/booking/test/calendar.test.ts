import { describe, expect, it } from 'vitest';
import type { Class } from '@studiodesk/shared';
import { createContext } from '@studiodesk/core';
import { buildCalendar, buildMonthGrid, buildWeekGrid, createSeries, findAvailability, findConflicts, previewSeries } from '@studiodesk/booking';
import { harness, seedInstructor, seedMembers, seedStudio, type Harness } from '@studiodesk/core/test';

let h: Harness;
let ctx: ReturnType<typeof createContext>;

async function setup(): Promise<void> {
  h = harness(new Date('2026-03-02T09:00:00.000Z'));
  ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
  await seedStudio(h, 'business');
  await seedInstructor(h);
}

async function addClass(id: string, dayOffset: number, hour: number, capacity = 10, name = 'Vinyasa Flow') {
  const start = h.at(dayOffset, hour);
  return h.repo.table('classes').insert({
    id,
    studioId: 'std_demo',
    name,
    instructorId: 'ins_001',
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 3600_000).toISOString(),
    capacity,
    durationMinutes: 60,
    status: 'scheduled',
    classType: name,
    createdAt: h.now().toISOString(),
    updatedAt: h.now().toISOString(),
  });
}

describe('buildCalendar', () => {
  it('groups classes by day with capacity totals', async () => {
    await setup();
    await addClass('c1', 0, 7);
    await addClass('c2', 0, 18);
    await addClass('c3', 1, 7);

    const calendar = await buildCalendar(ctx, { from: h.at(0, 0), to: h.at(6, 23) });
    expect(calendar.days).toHaveLength(7);
    expect(calendar.days[0]!.entries).toHaveLength(2);
    expect(calendar.days[0]!.isToday).toBe(true);
    expect(calendar.days[0]!.weekdayName).toBe('Monday');
    expect(calendar.days[1]!.entries).toHaveLength(1);
    expect(calendar.summary.totalClasses).toBe(3);
    expect(calendar.summary.totalSpotsLeft).toBe(30);
  });

  it('hides past classes unless asked', async () => {
    await setup();
    await addClass('past', -2, 7);
    await addClass('future', 2, 7);
    const upcoming = await buildCalendar(ctx, { from: h.at(-7, 0), to: h.at(7, 23), includePast: false });
    expect(upcoming.classes.map((c) => c.id)).toEqual(['future']);
  });

  it('filters out cancelled classes', async () => {
    await setup();
    const klass = await addClass('cancelled', 1, 7);
    await h.repo.table('classes').update(klass.id, { status: 'cancelled' });
    const calendar = await buildCalendar(ctx, { from: h.at(0, 0), to: h.at(6, 23) });
    expect(calendar.classes).toHaveLength(0);
  });
});

describe('buildWeekGrid / buildMonthGrid', () => {
  it('rolls back to Monday', async () => {
    await setup();
    // 2026-03-04 is a Wednesday.
    const week = await buildWeekGrid(ctx, new Date('2026-03-04T12:00:00.000Z'));
    expect(week.from.slice(0, 10)).toBe('2026-03-02');
    expect(week.days).toHaveLength(7);
  });

  it('renders six weeks of a month grid', async () => {
    await setup();
    const month = await buildMonthGrid(ctx, new Date('2026-03-15T12:00:00.000Z'));
    expect(month.days).toHaveLength(42);
    expect(month.days[0]!.date).toBe('2026-02-23');
  });
});

describe('findAvailability', () => {
  it('returns classes with free spots, respecting time windows', async () => {
    await setup();
    await addClass('morning', 1, 7, 2);
    await addClass('evening', 1, 19, 2);

    const all = await findAvailability(ctx, { from: h.at(0, 0), to: h.at(7, 23) });
    expect(all).toHaveLength(2);

    const mornings = await findAvailability(ctx, {
      from: h.at(0, 0),
      to: h.at(7, 23),
      toHour: 12,
    });
    expect(mornings.map((c) => c.id)).toEqual(['morning']);
  });
});

describe('findConflicts', () => {
  it('detects overlapping classes for one instructor', async () => {
    await setup();
    await addClass('a', 1, 10);
    await addClass('b', 1, 10);
    await addClass('c', 1, 14);

    const classes = await h.repo.table('classes').list();
    const conflicts = await findConflicts(ctx, classes);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.a.id).toBe('a');
    expect(conflicts[0]!.b.id).toBe('b');
  });
});

describe('recurring series', () => {
  it('previews occurrences and flags clashes', async () => {
    await setup();
    // A Monday class in week 2 (2026-03-09) that the series will collide with.
    await addClass('existing', 7, 9);

    const preview = await previewSeries(ctx, {
      rrule: 'DTSTART:20260302T090000Z\nFREQ=WEEKLY;BYDAY=MO;COUNT=8',
      instructorId: 'ins_001',
      durationMinutes: 60,
    });

    expect(preview.count).toBe(8);
    expect(preview.description).toBe('Mon');
    expect(preview.occurrences[0]!.date).toBe('2026-03-02');
    expect(preview.conflicts.some((c) => c.startTime.includes('2026-03-09'))).toBe(true);
  });

  it('creates the series and skips conflicting occurrences', async () => {
    await setup();
    // Week 2 Monday, same hour -> one occurrence must be skipped.
    await addClass('existing', 7, 9);

    const result = await createSeries(ctx, {
      name: 'Monday Flow',
      instructorId: 'ins_001',
      rrule: 'DTSTART:20260302T090000Z\nFREQ=WEEKLY;BYDAY=MO;COUNT=8',
      durationMinutes: 60,
      capacity: 15,
      from: h.at(0, 0),
    });

    expect(result.created).toHaveLength(7);
    expect(result.skipped).toBe(1);
    const stored = await h.repo.table('classes').list({ filter: { name: 'Monday Flow' } });
    expect(stored).toHaveLength(7);
    expect(stored.every((c: Class) => c.rrule?.includes('FREQ=WEEKLY'))).toBe(true);
    expect(stored[0]!.capacity).toBe(15);
  });
});

describe('weekload counts', () => {
  it('computes live booking counts per class', async () => {
    await setup();
    const seeded = await seedMembers(h, 4);
    const klass = await addClass('c1', 1, 9, 2);

    for (let i = 0; i < 2; i += 1) {
      await h.repo.table('bookings').insert({
        id: `bkg_${i}`,
        memberId: seeded[i]!.id,
        classId: klass.id,
        status: 'booked',
      });
    }
    await h.repo.table('bookings').insert({
      id: 'bkg_wl',
      memberId: seeded[2]!.id,
      classId: klass.id,
      status: 'waitlisted',
      waitlistPosition: 1,
    });

    const calendar = await buildCalendar(ctx, { from: h.at(0, 0), to: h.at(6, 23) });
    const entry = calendar.classes[0]!;
    expect(entry.booked).toBe(2);
    expect(entry.waitlisted).toBe(1);
    expect(entry.isFull).toBe(true);
    expect(entry.spotsLeft).toBe(0);
    expect(entry.isPast).toBe(false);
  });
});