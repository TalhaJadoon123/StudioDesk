import { beforeEach, describe, expect, it } from 'vitest';
import type { Class, Member } from '@studiodesk/shared';
import { createContext } from '@studiodesk/core';
import * as bookings from '@studiodesk/core';
import {
  harness,
  seedAttendanceForPastClass,
  seedClass,
  seedCreditPlan,
  seedFixtureBookings,
  seedInstructor,
  seedMembers,
  seedPlan,
  seedStudio,
  type Harness,
} from './fixtures.js';

let h: Harness;
let ctx: ReturnType<typeof createContext>;

beforeEach(async () => {
  h = harness();
  ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
  await seedStudio(h, 'business');
  await seedInstructor(h);
  await seedPlan(h, { id: 'plan_unlimited', classCredits: null });
});

describe('createBooking', () => {
  it('confirms a booking and consumes a credit', async () => {
    // The member must be on a credit-based plan for packs to be drawn down.
    await seedCreditPlan(h);
    const seeded = await seedMembers(h, 1, () => ({ planId: 'plan_credit' }));
    await h.repo.table('packs').insert({
      id: 'pak_1',
      memberId: seeded[0]!.id,
      name: '10 Class Pack',
      credits: 10,
      creditsRemaining: 10,
      priceCents: 15_000,
      currency: 'usd',
      purchasedAt: h.now().toISOString(),
      status: 'active',
    });
    const klass = await seedClass(h, { id: 'cls_1' });

    const result = await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    expect(result.booking.status).toBe('booked');
    expect(result.chargedCredits).toBe(1);
    expect((await h.repo.table('packs').findById('pak_1'))!.creditsRemaining).toBe(9);
  });

  it('does not charge unlimited plans', async () => {
    const seeded = await seedMembers(h, 1);
    await h.repo.table('packs').insert({
      id: 'pak_1',
      memberId: seeded[0]!.id,
      name: 'Pack',
      credits: 5,
      creditsRemaining: 5,
      priceCents: 0,
      currency: 'usd',
      purchasedAt: h.now().toISOString(),
      status: 'active',
    });
    const klass = await seedClass(h);
    const result = await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    expect(result.chargedCredits).toBe(0);
    expect((await h.repo.table('packs').findById('pak_1'))!.creditsRemaining).toBe(5);
  });

  it('rejects a double booking', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h);
    await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    await expect(
      bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id }),
    ).rejects.toThrow(/already booked/);
  });

  it('rejects cancelled and paused members', async () => {
    const seeded = await seedMembers(h, 2, (i) => ({ name: `M${i}` }));
    const klass = await seedClass(h);
    await bookings.cancelMember(ctx, seeded[0]!.id);
    await bookings.pauseMember(ctx, seeded[1]!.id);

    await expect(bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id })).rejects.toThrow(
      /cancelled their membership/,
    );
    await expect(bookings.createBooking(ctx, { memberId: seeded[1]!.id, classId: klass.id })).rejects.toThrow(
      /paused/,
    );
  });

  it('rejects a cancelled class', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h);
    await bookings.cancelClass(ctx, klass.id, 'studio shutdown');
    await expect(bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id })).rejects.toThrow(
      /has been cancelled/,
    );
  });
});

describe('capacity and waitlists', () => {
  // Shared fixtures for this block: one small class and six members.
  let seeded: Member[];
  let small: Class;

  beforeEach(async () => {
    seeded = await seedMembers(h, 6);
    small = await seedClass(h, { id: 'cls_small', capacity: 2 });
  });

  it('fails with class_full when the class is full', async () => {
    await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: small.id });
    await bookings.createBooking(ctx, { memberId: seeded[1]!.id, classId: small.id });

    await expect(
      bookings.createBooking(ctx, { memberId: seeded[2]!.id, classId: small.id }),
    ).rejects.toThrow(/is full \(2 spots\)/);
  });

  it('waitlists when allowed and numbers the queue', async () => {
    await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: small.id });
    await bookings.createBooking(ctx, { memberId: seeded[1]!.id, classId: small.id });

    const a = await bookings.createBooking(ctx, {
      memberId: seeded[2]!.id,
      classId: small.id,
      allowWaitlist: true,
    });
    const b = await bookings.createBooking(ctx, {
      memberId: seeded[3]!.id,
      classId: small.id,
      allowWaitlist: true,
    });
    const c = await bookings.createBooking(ctx, {
      memberId: seeded[4]!.id,
      classId: small.id,
      allowWaitlist: true,
    });

    expect(a.booking.status).toBe('waitlisted');
    expect(a.waitlistPosition).toBe(1);
    expect(b.waitlistPosition).toBe(2);
    expect(c.waitlistPosition).toBe(3);
  });

  it('promotes the head of the queue when a booking is cancelled', async () => {
    await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: small.id });
    await bookings.createBooking(ctx, { memberId: seeded[1]!.id, classId: small.id });
    const waiting = await bookings.createBooking(ctx, {
      memberId: seeded[2]!.id,
      classId: small.id,
      allowWaitlist: true,
    });
    await bookings.createBooking(ctx, {
      memberId: seeded[3]!.id,
      classId: small.id,
      allowWaitlist: true,
    });

    const target = (await bookings.listBookings(ctx, { classId: small.id, status: 'booked' }))[0]!;
    const result = await bookings.cancelBooking(ctx, target.id);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]!.id).toBe(waiting.booking.id);
    expect(result.promoted[0]!.status).toBe('booked');
    expect(result.promoted[0]!.waitlistPosition).toBeUndefined();

    // The queue renumbers with no gaps.
    const queue = await bookings.waitlist(ctx, small.id);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.waitlistPosition).toBe(1);
    expect(queue[0]!.memberName).toBe('Member 004');
  });

  it('promotes in order, filling every freed spot', async () => {
    const seeded = await seedMembers(h, 5, () => ({}), { prefix: 'multi' });
    const klass = await seedClass(h, { capacity: 3 });
    for (let i = 0; i < 3; i += 1) {
      await bookings.createBooking(ctx, { memberId: seeded[i]!.id, classId: klass.id });
    }
    for (let i = 3; i < 5; i += 1) {
      await bookings.createBooking(ctx, {
        memberId: seeded[i]!.id,
        classId: klass.id,
        allowWaitlist: true,
      });
    }

    expect((await bookings.classCapacity(ctx, klass.id)).waitlisted).toBe(2);

    // Cancel two different bookings so two waitlisted members are promoted.
    const confirmed = await bookings.listBookings(ctx, { classId: klass.id, status: 'booked' });
    expect(confirmed).toHaveLength(3);
    await bookings.cancelBooking(ctx, confirmed[0]!.id);
    const stillConfirmed = await bookings.listBookings(ctx, { classId: klass.id, status: 'booked' });
    await bookings.cancelBooking(
      ctx,
      stillConfirmed.find((b) => b.id !== confirmed[0]!.id)!.id,
    );

    const capacity = await bookings.classCapacity(ctx, klass.id);
    expect(capacity.confirmed).toBe(3);
    expect(capacity.waitlisted).toBe(0);
    expect(capacity.isFull).toBe(true);
  });

  it('skips waitlisted members who are no longer active', async () => {
    await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: small.id });
    await bookings.createBooking(ctx, { memberId: seeded[1]!.id, classId: small.id });
    await bookings.createBooking(ctx, {
      memberId: seeded[2]!.id,
      classId: small.id,
      allowWaitlist: true,
    });
    await bookings.createBooking(ctx, {
      memberId: seeded[3]!.id,
      classId: small.id,
      allowWaitlist: true,
    });

    // The person at the front of the queue cancels their membership.
    await bookings.cancelMember(ctx, seeded[2]!.id);

    const confirmed = await bookings.listBookings(ctx, { classId: small.id, status: 'booked' });
    const result = await bookings.cancelBooking(ctx, confirmed[0]!.id);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]!.memberId).toBe(seeded[3]!.id);
    const queue = await bookings.waitlist(ctx, small.id);
    expect(queue).toHaveLength(0);
  });

  it('emits booking.promoted exactly once', async () => {
    await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: small.id });
    await bookings.createBooking(ctx, { memberId: seeded[1]!.id, classId: small.id });
    await bookings.createBooking(ctx, {
      memberId: seeded[2]!.id,
      classId: small.id,
      allowWaitlist: true,
    });

    let promotions = 0;
    h.events.on('booking.promoted', () => {
      promotions += 1;
    });

    const confirmed = await bookings.listBookings(ctx, { classId: small.id, status: 'booked' });
    await bookings.cancelBooking(ctx, confirmed[0]!.id);
    expect(promotions).toBe(1);
  });

  it('leaving the waitlist renumbers the queue', async () => {
    await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: small.id });
    await bookings.createBooking(ctx, { memberId: seeded[1]!.id, classId: small.id });
    const first = await bookings.createBooking(ctx, {
      memberId: seeded[2]!.id,
      classId: small.id,
      allowWaitlist: true,
    });
    await bookings.createBooking(ctx, {
      memberId: seeded[3]!.id,
      classId: small.id,
      allowWaitlist: true,
    });
    const last = await bookings.createBooking(ctx, {
      memberId: seeded[4]!.id,
      classId: small.id,
      allowWaitlist: true,
    });

    await bookings.leaveWaitlist(ctx, first.booking.id);
    const queue = await bookings.waitlist(ctx, small.id);
    expect(queue.map((b) => b.memberId)).toEqual([seeded[3]!.id, seeded[4]!.id]);
    expect(queue[0]!.waitlistPosition).toBe(1);
    expect(queue[1]!.waitlistPosition).toBe(2);
    expect(last.booking.waitlistPosition).toBe(3);
  });

  it('blocks waitlists on the free plan', async () => {
    await seedStudio(h, 'free');
    const klass = await seedClass(h, { id: 'cls_free', capacity: 1 });
    await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    await expect(
      bookings.createBooking(ctx, {
        memberId: seeded[1]!.id,
        classId: klass.id,
        allowWaitlist: true,
      }),
    ).rejects.toThrow(/Waitlists are a Starter feature/);
  });
});

describe('cancellation, late cancels and credits', () => {
  it('refunds the credit on an early cancellation', async () => {
    await seedCreditPlan(h);
    const seeded = await seedMembers(h, 1, () => ({ planId: 'plan_credit' }));
    await h.repo.table('packs').insert({
      id: 'pak_1',
      memberId: seeded[0]!.id,
      name: 'Pack',
      credits: 5,
      creditsRemaining: 5,
      priceCents: 0,
      currency: 'usd',
      purchasedAt: h.now().toISOString(),
      status: 'active',
    });
    const klass = await seedClass(h, { startTime: h.at(2, 7) });
    const created = await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    expect((await h.repo.table('packs').findById('pak_1'))!.creditsRemaining).toBe(4);

    const result = await bookings.cancelBooking(ctx, created.booking.id);
    expect(result.late).toBe(false);
    expect(result.refundCredits).toBe(1);
    expect((await h.repo.table('packs').findById('pak_1'))!.creditsRemaining).toBe(5);
  });

  it('marks a late cancellation and keeps the credit', async () => {
    await seedCreditPlan(h);
    const seeded = await seedMembers(h, 1, () => ({ planId: 'plan_credit' }));
    await h.repo.table('packs').insert({
      id: 'pak_1',
      memberId: seeded[0]!.id,
      name: 'Pack',
      credits: 5,
      creditsRemaining: 5,
      priceCents: 0,
      currency: 'usd',
      purchasedAt: h.now().toISOString(),
      status: 'active',
    });
    // Starts in 1 hour - inside the 4 hour late-cancel window.
    const klass = await seedClass(h, { startTime: h.at(0, 10) });
    const created = await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id });

    let late = false;
    h.events.on('booking.cancelled', (payload) => {
      late = payload.late;
    });

    const result = await bookings.cancelBooking(ctx, created.booking.id);
    expect(result.late).toBe(true);
    expect(result.refundCredits).toBe(0);
    expect(late).toBe(true);
    expect((await h.repo.table('packs').findById('pak_1'))!.creditsRemaining).toBe(4);
  });

  it('never flags a staff cancellation as late', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h, { startTime: h.at(0, 10) });
    const created = await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    const result = await bookings.cancelBooking(ctx, created.booking.id, { byStaff: true });
    expect(result.late).toBe(false);
  });

  it('refuses to cancel twice or to cancel an attended class', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h);
    const created = await bookings.createBooking(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    await bookings.cancelBooking(ctx, created.booking.id);
    await expect(bookings.cancelBooking(ctx, created.booking.id)).rejects.toThrow(/already cancelled/);

    const second = await bookings.createBooking(ctx, {
      memberId: seeded[0]!.id,
      classId: klass.id,
      override: true,
    });
    await bookings.markAttended(ctx, second.booking.id);
    await expect(bookings.cancelBooking(ctx, second.booking.id)).rejects.toThrow(/already attended/);
  });
});

describe('finalizeClass', () => {
  it('marks stragglers as no-shows and completes the class', async () => {
    const seeded = await seedMembers(h, 3, (i) => ({ name: `Final ${i}` }), { prefix: 'fin' });
    const klass = await seedClass(h, { startTime: h.at(-1, 7) });
    // The class already happened, so staff are recording what occurred.
    const a = await bookings.createBooking(ctx, {
      memberId: seeded[0]!.id,
      classId: klass.id,
      override: true,
    });
    const b = await bookings.createBooking(ctx, {
      memberId: seeded[1]!.id,
      classId: klass.id,
      override: true,
    });
    const c = await bookings.createBooking(ctx, {
      memberId: seeded[2]!.id,
      classId: klass.id,
      override: true,
    });
    await bookings.markAttended(ctx, a.booking.id);

    let completed: { noShows: number; attended: number } | undefined;
    h.events.on('class.completed', (payload) => {
      completed = { noShows: payload.noShows, attended: payload.attended };
    });

    const result = await bookings.finalizeClass(ctx, klass.id);
    expect(result.noShows).toBe(2);
    expect(result.attended).toBe(1);
    expect(completed).toEqual({ noShows: 2, attended: 1 });
    expect((await h.repo.table('bookings').findById(b.booking.id))!.status).toBe('no-show');
    expect((await h.repo.table('bookings').findById(c.booking.id))!.status).toBe('no-show');
    expect((await h.repo.table('classes').findById(klass.id))!.status).toBe('completed');
  });
});

describe('class capacity and roster', () => {
  it('reports capacity for the fixture classes', async () => {
    const members = await seedMembers(h, 32);
    const fixture = await seedFixtureBookings(h, members);

    expect(await bookings.classCapacity(ctx, fixture.classIds.open)).toMatchObject({
      capacity: 10,
      confirmed: 4,
      waitlisted: 0,
      spotsLeft: 6,
      isFull: false,
    });
    expect(await bookings.classCapacity(ctx, fixture.classIds.full)).toMatchObject({
      confirmed: 10,
      waitlisted: 6,
      spotsLeft: 0,
      isFull: true,
    });
  });

  it('builds a roster with check-in state', async () => {
    const members = await seedMembers(h, 32);
    const fixture = await seedFixtureBookings(h, members);
    await seedAttendanceForPastClass(h, fixture.classIds.past);

    const roster = await bookings.classRoster(ctx, fixture.classIds.past);
    expect(roster).toHaveLength(4);
    expect(roster.filter((r) => r.checkedIn)).toHaveLength(2);
    const attended = roster.find((r) => r.bookingId === 'bkg_past_0')!;
    expect(attended.checkedIn).toBe(true);
    expect(attended.memberName).toBe('Member 029');
  });

  it('sorts the roster with waitlisted members last', async () => {
    const members = await seedMembers(h, 32);
    const fixture = await seedFixtureBookings(h, members);
    const roster = await bookings.classRoster(ctx, fixture.classIds.full);
    expect(roster[0]!.status).toBe('booked');
    expect(roster.slice(10).every((r) => r.status === 'waitlisted')).toBe(true);
  });
});

describe('createBookings (bulk)', () => {
  it('reports per-member failures without aborting', async () => {
    const seeded = await seedMembers(h, 3, (i) => ({ name: `Bulk ${i}` }));
    await bookings.cancelMember(ctx, seeded[2]!.id);
    const klass = await seedClass(h);

    const result = await bookings.createBookings(
      ctx,
      seeded.map((m) => ({ memberId: m.id, classId: klass.id, source: 'staff' as const })),
    );
    expect(result.booked).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.input.memberId).toBe(seeded[2]!.id);
  });
});

describe('the 32-booking fixture end to end', () => {
  it('handles a realistic cancellation cascade', async () => {
    const members = await seedMembers(h, 32);
    const fixture = await seedFixtureBookings(h, members);

    const full = await bookings.classCapacity(ctx, fixture.classIds.full);
    expect(full.confirmed).toBe(10);

    // Cancel three confirmed bookings on the sold-out class.
    const confirmed = await bookings.listBookings(ctx, {
      classId: fixture.classIds.full,
      status: 'booked',
    });
    expect(confirmed).toHaveLength(10);

    const promoted: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const target = (
        await bookings.listBookings(ctx, { classId: fixture.classIds.full, status: 'booked' })
      )[0]!;
      const result = await bookings.cancelBooking(ctx, target.id, { byStaff: true });
      promoted.push(...result.promoted.map((b) => b.id));
    }

    expect(promoted).toHaveLength(3);
    const after = await bookings.classCapacity(ctx, fixture.classIds.full);
    expect(after.confirmed).toBe(10);
    expect(after.waitlisted).toBe(3);

    // Positions are now 1..3 with no gaps.
    const queue = await bookings.waitlist(ctx, fixture.classIds.full);
    expect(queue.map((b) => b.waitlistPosition)).toEqual([1, 2, 3]);
    // The three people at the front of the queue were promoted out of it.
    expect(queue.map((b) => b.memberId)).toEqual(fixture.waitlistedOnFull.slice(3));
  });
});