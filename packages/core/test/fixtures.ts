import { EventBus, type Member } from '@studiodesk/shared';
import { MemoryRepository } from '@studiodesk/core';

/**
 * Shared test fixtures.
 *
 * Everything is deterministic and clock-pinned, so assertions about "30 days
 * ago" never flake.
 */

export const T0 = new Date('2026-03-02T09:00:00.000Z');

export interface Harness {
  repo: MemoryRepository;
  events: EventBus;
  now: () => Date;
  advance(days: number): void;
  /** A clock-derived date `dayOffset` days from now, at the given UTC time. */
  at(dayOffset: number, hour?: number, minute?: number): Date;
  setNow(date: Date): void;
}

export function harness(start: Date = T0): Harness {
  let clock = new Date(start.getTime());
  return {
    repo: new MemoryRepository(),
    events: new EventBus(),
    now: () => new Date(clock.getTime()),
    advance: (days) => {
      clock = new Date(clock.getTime() + days * 86_400_000);
    },
    at: (dayOffset, hour = 9, minute = 0) => {
      const d = new Date(clock.getTime() + dayOffset * 86_400_000);
      d.setUTCHours(hour, minute, 0, 0);
      return d;
    },
    setNow: (date) => {
      clock = new Date(date.getTime());
    },
  };
}

/** N deterministic member names. */
export function memberNames(count: number, prefix = 'Member'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1).padStart(3, '0')}`);
}

/**
 * Insert-or-update, so a fixture helper can be called more than once (tests
 * share one harness per file). The cast bridges the per-table row union to the
 * generic `T` - the helper is only ever called with the matching row type.
 */
async function put<T extends { id: string }>(
  h: Harness,
  table: 'studios' | 'members' | 'instructors' | 'plans' | 'classes',
  row: T,
): Promise<T> {
  const t = h.repo.table(table) as unknown as {
    findById: (id: string) => Promise<T | null>;
    insert: (row: T) => Promise<T>;
    update: (id: string, row: T) => Promise<T>;
  };
  const existing = await t.findById(row.id);
  return existing ? t.update(row.id, row) : t.insert(row);
}

export interface SeedMembersOptions {
  /** Id/email prefix so several calls do not collide on `mem_001`. */
  prefix?: string;
  overrides?: (index: number) => Partial<Member>;
}

export async function seedMembers(
  h: Harness,
  count: number,
  overrides: (index: number) => Partial<Member> = () => ({}),
  options: SeedMembersOptions = {},
): Promise<Member[]> {
  const out: Member[] = [];
  const prefix = options.prefix ?? 'mem';
  const override = options.overrides ?? overrides;
  for (let i = 0; i < count; i += 1) {
    const at = h.now().toISOString();
    const slug = `${prefix}_${String(i + 1).padStart(3, '0')}`;
    const member: Member = {
      id: slug,
      name: memberNames(count)[i]!,
      email: `${slug}@example.com`,
      planId: 'plan_unlimited',
      status: 'active',
      studioId: 'std_demo',
      joinedAt: at,
      monthlyPriceCents: 8900,
      currency: 'usd',
      createdAt: at,
      updatedAt: at,
      ...override(i),
    };
    out.push(await put(h, 'members', member));
  }
  return out;
}

/** A credit-based plan, for tests that assert on pack consumption. */
export async function seedCreditPlan(h: Harness, credits = 8, priceCents = 6900) {
  return seedPlan(h, {
    id: 'plan_credit',
    name: `${credits} Classes / month`,
    classCredits: credits,
    priceCents,
  });
}

export async function seedInstructor(h: Harness, name = 'Maya Krishnan') {
  const at = h.now().toISOString();
  return put(h, 'instructors', {
    id: 'ins_001',
    studioId: 'std_demo',
    name,
    color: '#6366f1',
    active: true,
    createdAt: at,
    updatedAt: at,
  });
}

export async function seedStudio(h: Harness, tier: 'free' | 'starter' | 'business' = 'business') {
  const at = h.now().toISOString();
  return put(h, 'studios', {
    id: 'std_demo',
    name: 'Riverbend Yoga',
    tier,
    timezone: 'UTC',
    currency: 'usd',
    settings: { lateCancelHours: 4, noShowFeeCents: 500, lateCancelFeeCents: 300 },
    checkinGeofence: { latitude: 51.5074, longitude: -0.1278, radiusMeters: 150 },
    createdAt: at,
    updatedAt: at,
  });
}

export async function seedClass(
  h: Harness,
  options: {
    id?: string;
    name?: string;
    startTime?: Date;
    capacity?: number;
    instructorId?: string;
    creditCost?: number;
    waitlistEnabled?: boolean;
    lateCancelHours?: number;
  } = {},
) {
  const at = h.now().toISOString();
  const startTime = options.startTime ?? h.at(1, 18);
  const klass = {
    id: options.id ?? `cls_${Math.random().toString(36).slice(2, 8)}`,
    studioId: 'std_demo',
    name: options.name ?? 'Vinyasa Flow',
    instructorId: options.instructorId ?? 'ins_001',
    startTime: startTime.toISOString(),
    endTime: new Date(startTime.getTime() + 60 * 60_000).toISOString(),
    capacity: options.capacity ?? 10,
    durationMinutes: 60,
    creditCost: options.creditCost ?? 1,
    classType: options.name ?? 'Vinyasa Flow',
    waitlistEnabled: options.waitlistEnabled ?? true,
    lateCancelHours: options.lateCancelHours ?? 4,
    status: 'scheduled' as const,
    createdAt: at,
    updatedAt: at,
  };
  return h.repo.table('classes').insert(klass);
}

export async function seedPlan(
  h: Harness,
  options: { id?: string; name?: string; priceCents?: number; classCredits?: number | null } = {},
) {
  const at = h.now().toISOString();
  return put(h, 'plans', {
    id: options.id ?? 'plan_unlimited',
    studioId: 'std_demo',
    name: options.name ?? 'Unlimited Monthly',
    tier: 'starter',
    priceCents: options.priceCents ?? 8900,
    currency: 'usd',
    interval: 'month',
    classCredits: options.classCredits === undefined ? null : options.classCredits,
    active: true,
    createdAt: at,
    updatedAt: at,
  });
}

/**
 * The fixture the brief calls for: **32 bookings** across four classes with a
 * realistic mix of confirmed, waitlisted and cancelled states.
 */
export interface FixtureBookingSet {
  classIds: { open: string; nearlyFull: string; full: string; past: string };
  bookings: Array<{ id: string; memberId: string; classId: string; status: string }>;
  confirmedOnFull: string[];
  waitlistedOnFull: string[];
}

/**
 * Builds 4 classes and 32 bookings:
 *   - `open`       capacity 10, 4 bookings
 *   - `nearlyFull` capacity 10, 8 bookings
 *   - `full`       capacity 10, 10 confirmed + 6 waitlisted
 *   - `past`       capacity 10, 4 bookings (2 attended, 1 no-show, 1 cancelled)
 */
export async function seedFixtureBookings(h: Harness, members: Member[]): Promise<FixtureBookingSet> {
  // Tolerate being called when the shared studio/instructor already exist.
  await seedInstructor(h);
  const [open, nearlyFull, full, past] = await Promise.all([
    seedClass(h, { id: 'cls_open', name: 'Open Class', capacity: 10, startTime: h.at(1, 7) }),
    seedClass(h, { id: 'cls_nearly', name: 'Nearly Full', capacity: 10, startTime: h.at(1, 12) }),
    seedClass(h, { id: 'cls_full', name: 'Sold Out', capacity: 10, startTime: h.at(2, 18) }),
    seedClass(h, { id: 'cls_past', name: 'Past Class', capacity: 10, startTime: h.at(-3, 7) }),
  ]);

  const bookings: FixtureBookingSet['bookings'] = [];
  const bookingsTable = h.repo.table('bookings');
  const push = async (
    id: string,
    memberId: string,
    classId: string,
    status: string,
    waitlistPosition?: number,
  ) => {
    const booking = {
      id,
      memberId,
      classId,
      status: status as never,
      waitlistPosition,
      bookedAt: h.now().toISOString(),
      creditsCharged: status === 'booked' ? 1 : 0,
      source: 'web' as const,
      createdAt: h.now().toISOString(),
      updatedAt: h.now().toISOString(),
    };
    bookings.push({ id, memberId, classId, status });
    const existing = await bookingsTable.findById(id);
    return existing ? bookingsTable.update(id, booking) : bookingsTable.insert(booking);
  };

  // open: 4
  for (let i = 0; i < 4; i += 1) await push(`bkg_open_${i}`, members[i]!.id, open.id, 'booked');

  // nearlyFull: 8
  for (let i = 4; i < 12; i += 1) await push(`bkg_nearly_${i}`, members[i]!.id, nearlyFull.id, 'booked');

  // full: 10 confirmed + 6 waitlisted
  const confirmedOnFull: string[] = [];
  for (let i = 12; i < 22; i += 1) {
    await push(`bkg_full_${i}`, members[i]!.id, full.id, 'booked');
    confirmedOnFull.push(members[i]!.id);
  }
  const waitlistedOnFull: string[] = [];
  for (let i = 22; i < 28; i += 1) {
    await push(`bkg_wl_${i}`, members[i]!.id, full.id, 'waitlisted', i - 21);
    waitlistedOnFull.push(members[i]!.id);
  }

  // past: 2 attended, 1 no-show, 1 cancelled (4 total)
  await push('bkg_past_0', members[28]!.id, past.id, 'attended');
  await push('bkg_past_1', members[29]!.id, past.id, 'attended');
  await push('bkg_past_2', members[30]!.id, past.id, 'no-show');
  await push('bkg_past_3', members[31]!.id, past.id, 'cancelled');

  return {
    classIds: { open: open.id, nearlyFull: nearlyFull.id, full: full.id, past: past.id },
    bookings,
    confirmedOnFull,
    waitlistedOnFull,
  };
}

/** Attendance rows for the past-class fixture. */
export async function seedAttendanceForPastClass(h: Harness, pastClassId: string) {
  const rows = [
    { memberId: 'mem_029', bookingId: 'bkg_past_0' },
    { memberId: 'mem_030', bookingId: 'bkg_past_1' },
  ];
  for (const [index, row] of rows.entries()) {
    const at = new Date(new Date(h.now().getTime() - 3 * 86_400_000).getTime());
    at.setUTCHours(7, 5 + index, 0, 0);
    await h.repo.table('attendance').insert({
      id: `att_past_${index}`,
      memberId: row.memberId,
      classId: pastClassId,
      bookingId: row.bookingId,
      method: 'qr',
      checkedInAt: at.toISOString(),
      lateByMinutes: 5 + index,
    });
  }
}