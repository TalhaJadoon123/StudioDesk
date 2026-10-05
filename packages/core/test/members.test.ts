import { beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '@studiodesk/core';
import * as members from '@studiodesk/core';
import { harness, seedMembers, seedPlan, seedStudio, type Harness } from './fixtures.js';

function setup(tier: 'free' | 'starter' | 'business' = 'business') {
  const h = harness();
  const ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
  return { h, ctx };
}

let h: Harness;
let ctx: ReturnType<typeof setup>['ctx'];

beforeEach(async () => {
  const made = setup();
  h = made.h;
  ctx = made.ctx;
  await seedStudio(h, 'business');
  await seedPlan(h);
});

describe('createMember', () => {
  it('creates an active member with defaults', async () => {
    const member = await members.createMember(ctx, { name: 'Ada Lovelace' });
    expect(member.name).toBe('Ada Lovelace');
    expect(member.status).toBe('active');
    expect(member.id).toMatch(/^mem_/);
    expect(member.joinedAt).toBe(h.now().toISOString());
    expect(member.studioId).toBe('std_demo');
  });

  it('lowercases email and rejects duplicates', async () => {
    await members.createMember(ctx, { name: 'A', email: 'Ada@Example.com' });
    await expect(
      members.createMember(ctx, { name: 'B', email: 'ada@example.com' }),
    ).rejects.toThrow(/already exists/);
  });

  it('enforces the free-tier member cap', async () => {
    await seedStudio(h, 'free');
    await seedMembers(h, 30);
    await expect(members.createMember(ctx, { name: 'One Too Many' })).rejects.toThrow(
      /allows 30 active members/,
    );
    // Cancelling someone frees a slot.
    const roster = await members.listMembers(ctx, { status: 'active' });
    await members.cancelMember(ctx, roster[0]!.id);
    const created = await members.createMember(ctx, { name: 'Now There Is Room' });
    expect(created.status).toBe('active');
  });

  it('does not count paused members against the cap', async () => {
    await seedStudio(h, 'free');
    const seeded = await seedMembers(h, 30);
    await members.pauseMember(ctx, seeded[0]!.id);
    await expect(members.createMember(ctx, { name: 'Fits' })).resolves.toBeTruthy();
  });
});

describe('member lifecycle', () => {
  it('cancels a member', async () => {
    const [member] = await seedMembers(h, 1);
    const cancelled = await members.cancelMember(ctx, member!.id, 'moved away');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBeTruthy();
    expect(cancelled.notes).toContain('moved away');
    // Idempotent.
    expect((await members.cancelMember(ctx, member!.id)).status).toBe('cancelled');
  });

  it('pauses and resumes', async () => {
    const [member] = await seedMembers(h, 1);
    const paused = await members.pauseMember(ctx, member!.id, 30);
    expect(paused.status).toBe('paused');
    expect(paused.pausedUntil).toBe(h.at(30).toISOString().slice(0, 10));

    const resumed = await members.resumeMember(ctx, member!.id);
    expect(resumed.status).toBe('active');
    expect(resumed.pausedUntil).toBeUndefined();
  });

  it('refuses to pause a cancelled member', async () => {
    const [member] = await seedMembers(h, 1);
    await members.cancelMember(ctx, member!.id);
    await expect(members.pauseMember(ctx, member!.id)).rejects.toThrow(/Cancelled members/);
    await expect(members.resumeMember(ctx, member!.id)).rejects.toThrow(/Cancelled members/);
  });

  it('auto-resumes expired pauses', async () => {
    const seeded = await seedMembers(h, 3);
    await members.pauseMember(ctx, seeded[0]!.id, 10);
    await members.pauseMember(ctx, seeded[1]!.id, 60);

    h.advance(20);
    expect(await members.reconcilePauses(ctx)).toBe(1);
    expect((await members.requireMember(ctx, seeded[0]!.id)).status).toBe('active');
    expect((await members.requireMember(ctx, seeded[1]!.id)).status).toBe('paused');
  });
});

describe('listMembers', () => {
  beforeEach(async () => {
    await seedMembers(h, 10);
  });

  it('filters by status', async () => {
    const active = await members.listMembers(ctx, { status: 'active' });
    expect(active).toHaveLength(10);
    const roster = await members.listMembers(ctx);
    await members.pauseMember(ctx, roster[0]!.id);
    expect(await members.listMembers(ctx, { status: 'active' })).toHaveLength(9);
    expect(await members.listMembers(ctx, { status: 'paused' })).toHaveLength(1);
  });

  it('searches name and email', async () => {
    expect(await members.listMembers(ctx, { search: 'Member 003' })).toHaveLength(1);
    // Emails follow the id prefix, e.g. `mem_005@example.com`.
    expect(await members.listMembers(ctx, { search: 'mem_005@' })).toHaveLength(1);
    expect(await members.listMembers(ctx, { search: 'nobody' })).toHaveLength(0);
    // Case-insensitive: 001..009 match, 010 does not.
    expect(await members.listMembers(ctx, { search: 'MEMBER 00' })).toHaveLength(9);
    expect(await members.listMembers(ctx, { search: 'member' })).toHaveLength(10);
  });

  it('sorts and paginates', async () => {
    const page = await members.listMembersPaginated(ctx, { limit: 4, offset: 0 });
    expect(page.items).toHaveLength(4);
    expect(page.total).toBe(10);
    expect(page.pageSize).toBe(4);
    expect(page.page).toBe(1);
    expect(page.hasMore).toBe(true);

    const last = await members.listMembersPaginated(ctx, { limit: 4, offset: 8 });
    expect(last.items).toHaveLength(2);
    expect(last.hasMore).toBe(false);

    const desc = await members.listMembers(ctx, { sort: 'name', dir: 'desc' });
    expect(desc[0]!.name).toBe('Member 010');
  });

  it('counts by status', async () => {
    const roster = await members.listMembers(ctx);
    await members.pauseMember(ctx, roster[0]!.id);
    await members.cancelMember(ctx, roster[1]!.id);
    expect(await members.countByStatus(ctx)).toEqual({ active: 8, paused: 1, cancelled: 1 });
  });
});

describe('member usage rollup', () => {
  it('computes visits, attendance rate and tenure', async () => {
    const seeded = await seedMembers(h, 2, (i) => ({
      joinedAt: h.at(-100).toISOString(),
      status: 'active' as const,
      name: `Member ${i}`,
    }));
    const member = seeded[0]!;

    // Three visits in the last 30 days, two before that.
    for (const offset of [-1, -5, -20]) {
      await h.repo.table('attendance').insert({
        id: `att_${offset}`,
        memberId: member.id,
        classId: 'cls_x',
        method: 'qr',
        checkedInAt: h.at(offset, 7).toISOString(),
      });
    }
    await h.repo.table('attendance').insert({
      id: 'att_old',
      memberId: member.id,
      classId: 'cls_x',
      method: 'qr',
      checkedInAt: h.at(-40, 7).toISOString(),
    });
    await h.repo.table('attendance').insert({
      id: 'att_older',
      memberId: member.id,
      classId: 'cls_x',
      method: 'qr',
      checkedInAt: h.at(-50, 7).toISOString(),
    });

    // Two resolved bookings: one attended, one no-show.
    await h.repo.table('bookings').insert({
      id: 'bkg_att',
      memberId: member.id,
      classId: 'cls_x',
      status: 'attended',
    });
    await h.repo.table('bookings').insert({
      id: 'bkg_up',
      memberId: member.id,
      classId: 'cls_x',
      status: 'booked',
    });
    await h.repo.table('bookings').insert({
      id: 'bkg_ns',
      memberId: member.id,
      classId: 'cls_x',
      status: 'no-show',
    });

    const usage = await members.memberUsage(ctx, member.id);
    expect(usage.visitsLast30Days).toBe(3);
    expect(usage.visitsPrev30Days).toBe(2);
    expect(usage.daysSinceLastVisit).toBe(1);
    expect(usage.attendanceRate).toBe(0.5);
    expect(usage.tenureDays).toBe(100);
    expect(usage.upcomingBookings).toBe(1);
    expect(usage.lifetimeVisits).toBe(5);
    expect(usage.churnRisk).toBeLessThan(0.5);
  });

  it('treats a member with no history as lower risk than a lapsed one', async () => {
    // A brand-new joiner with no visits yet is still in the grace period.
    const [fresh] = await seedMembers(h, 1, () => ({}), { prefix: 'fresh' });
    const [lapsed] = await seedMembers(
      h,
      1,
      (i) => ({ name: `Lapsed ${i}`, joinedAt: h.at(-400).toISOString() }),
      { prefix: 'lapsed' },
    );
    await h.repo.table('attendance').insert({
      id: 'att_lapsed',
      memberId: lapsed!.id,
      classId: 'cls_x',
      method: 'qr',
      checkedInAt: h.at(-70, 7).toISOString(),
    });

    const freshRisk = (await members.memberUsage(ctx, fresh!.id)).churnRisk;
    const lapsedRisk = (await members.memberUsage(ctx, lapsed!.id)).churnRisk;
    expect(lapsedRisk).toBeGreaterThan(freshRisk);
    expect(lapsedRisk).toBeGreaterThanOrEqual(0.5);
  });
});

describe('heuristicRisk', () => {
  const base = {
    visitsLast30Days: 4,
    visitsPrev30Days: 4,
    daysSinceLastVisit: 7,
    attendanceRate: 0.9,
    lateCancels: 0,
    noShows: 0,
    outstandingCents: 0,
    tenureDays: 200,
    upcomingBookings: 1,
  };

  it('is clamped to 0..1', () => {
    const low = members.heuristicRisk({ ...base, daysSinceLastVisit: 0, upcomingBookings: 3 });
    const high = members.heuristicRisk({
      ...base,
      visitsLast30Days: 0,
      visitsPrev30Days: 8,
      daysSinceLastVisit: null,
      attendanceRate: 0,
      lateCancels: 5,
      noShows: 5,
      outstandingCents: 20_000,
      upcomingBookings: 0,
    });
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(1);
    expect(high).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThan(0.5);
  });

  it('penalises a big frequency drop more than a small one', () => {
    const big = members.heuristicRisk({ ...base, visitsLast30Days: 0, visitsPrev30Days: 8 });
    const small = members.heuristicRisk({ ...base, visitsLast30Days: 7, visitsPrev30Days: 8 });
    expect(big).toBeGreaterThan(small);
  });

  it('is more forgiving of brand-new members', () => {
    // A brand-new member who has already no-showed is still treated more gently
    // than a long-standing member with the same behaviour.
    const messy = {
      ...base,
      attendanceRate: 0.5,
      noShows: 2,
      daysSinceLastVisit: 14,
      upcomingBookings: 0,
      visitsLast30Days: 2,
      visitsPrev30Days: 4,
    };
    const newMember = members.heuristicRisk({ ...messy, tenureDays: 14 });
    const veteran = members.heuristicRisk({ ...messy, tenureDays: 900 });
    expect(newMember).toBeLessThan(veteran);
  });

  it('maps risk to bands', () => {
    expect(members.churnBandFor(0.1)).toBe('low');
    expect(members.churnBandFor(0.3)).toBe('medium');
    expect(members.churnBandFor(0.6)).toBe('high');
    expect(members.churnBandFor(0.9)).toBe('at-risk');
  });
});

describe('getMemberDetail', () => {
  it('assembles the full member view', async () => {
    const seeded = await seedMembers(h, 2, (i) => ({ name: `Detail ${i}` }));
    const member = seeded[0]!;

    const klass = await h.repo.table('classes').insert({
      id: 'cls_1',
      name: 'Vinyasa Flow',
      instructorId: 'ins_1',
      startTime: h.at(1, 7).toISOString(),
      capacity: 10,
    });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: member.id,
      classId: klass.id,
      status: 'booked',
      bookedAt: h.now().toISOString(),
    });
    await h.repo.table('attendance').insert({
      id: 'att_1',
      memberId: member.id,
      classId: klass.id,
      bookingId: 'bkg_1',
      method: 'qr',
      checkedInAt: h.at(-2, 7).toISOString(),
    });
    await h.repo.table('invoices').insert({
      id: 'inv_1',
      memberId: member.id,
      number: 'INV-2026-0001',
      status: 'paid',
      currency: 'usd',
      subtotalCents: 8900,
      taxCents: 0,
      discountCents: 0,
      totalCents: 8900,
      amountPaidCents: 8900,
      amountDueCents: 0,
      lineItems: [],
      createdAt: h.at(-5).toISOString(),
    });

    const detail = await members.getMemberDetail(ctx, member.id);
    expect(detail.member.name).toBe('Detail 0');
    expect(detail.upcoming).toHaveLength(1);
    expect(detail.upcoming[0]!.className).toBe('Vinyasa Flow');
    expect(detail.stats.lifetimeVisits).toBe(1);
    expect(detail.stats.revenueCents).toBe(8900);
    expect(detail.stats.lastVisitAt).toBe(h.at(-2, 7).toISOString());
    expect(detail.invoices).toHaveLength(1);
  });

  it('throws for an unknown member', async () => {
    await expect(members.getMemberDetail(ctx, 'mem_nope')).rejects.toThrow(/not found/);
  });
});

describe('bulk operations', () => {
  it('bulk-updates status', async () => {
    const seeded = await seedMembers(h, 4);
    const ids = seeded.slice(0, 2).map((m) => m.id);
    expect(await members.bulkUpdateStatus(ctx, ids, 'paused')).toBe(2);
    expect(await members.listMembers(ctx, { status: 'paused' })).toHaveLength(2);
    expect(await members.bulkUpdateStatus(ctx, ids, 'active')).toBe(2);
  });
});