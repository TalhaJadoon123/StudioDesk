import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRepository, matchesFilter, createContext } from '@studiodesk/core';
import { harness, seedFixtureBookings, seedMembers } from './fixtures.js';

describe('repository filter language', () => {
  const row = {
    id: 'bkg_1',
    memberId: 'mem_1',
    classId: 'cls_1',
    status: 'booked',
    waitlistPosition: 3,
    creditsCharged: 1,
    notes: null,
  };

  it('matches equality and arrays', () => {
    expect(matchesFilter(row, { status: 'booked' })).toBe(true);
    expect(matchesFilter(row, { status: 'waitlisted' })).toBe(false);
    expect(matchesFilter(row, { memberId: ['mem_1', 'mem_2'] })).toBe(true);
    expect(matchesFilter(row, {})).toBe(true);
    expect(matchesFilter(row)).toBe(true);
  });

  it('combines multiple operators in one object', () => {
    // This is the range query the calendar relies on.
    expect(matchesFilter({ n: 5 }, { n: { $gte: 3, $lte: 7 } })).toBe(true);
    expect(matchesFilter({ n: 9 }, { n: { $gte: 3, $lte: 7 } })).toBe(false);
    expect(matchesFilter({ n: 3 }, { n: { $gte: 3, $lte: 7 } })).toBe(true);
    expect(matchesFilter({ n: 7 }, { n: { $gte: 3, $lte: 7 } })).toBe(true);
  });

  it('supports comparison operators', () => {
    expect(matchesFilter(row, { waitlistPosition: { $gt: 2 } })).toBe(true);
    expect(matchesFilter(row, { waitlistPosition: { $lt: 2 } })).toBe(false);
    expect(matchesFilter(row, { waitlistPosition: { $ne: 3 } })).toBe(false);
    expect(matchesFilter(row, { status: { $in: ['booked', 'waitlisted'] } })).toBe(true);
    expect(matchesFilter(row, { status: { $nin: ['booked'] } })).toBe(false);
  });

  it('supports $or, $and and $not', () => {
    expect(matchesFilter(row, { $or: [{ status: 'booked' }, { status: 'waitlisted' }] })).toBe(true);
    expect(matchesFilter(row, { $and: [{ status: 'booked' }, { classId: 'cls_1' }] })).toBe(true);
    expect(matchesFilter(row, { $and: [{ status: 'booked' }, { classId: 'cls_2' }] })).toBe(false);
    expect(matchesFilter(row, { $not: { status: 'booked' } })).toBe(false);
  });

  it('supports $isNull and $like', () => {
    expect(matchesFilter(row, { notes: { $isNull: true } })).toBe(true);
    expect(matchesFilter(row, { status: { $like: 'BOOK' } })).toBe(true);
    expect(matchesFilter(row, { status: { $like: 'zzz' } })).toBe(false);
  });

  it('does not match rows where the field is missing for comparisons', () => {
    expect(matchesFilter({}, { missing: { $gte: 1 } })).toBe(false);
  });
});

describe('MemoryRepository', () => {
  let repo: MemoryRepository;

  beforeEach(() => {
    repo = new MemoryRepository();
  });

  it('inserts, reads and updates', async () => {
    const members = repo.table('members');
    await members.insert({ id: 'mem_1', name: 'Ada', planId: 'p', status: 'active' });
    expect(await members.count()).toBe(1);
    expect((await members.findById('mem_1'))!.name).toBe('Ada');

    const updated = await members.update('mem_1', { name: 'Ada L' });
    expect(updated.name).toBe('Ada L');
    // The id can never be changed by an update.
    await members.update('mem_1', { id: 'hacked' as never });
    expect((await members.findById('mem_1'))!.id).toBe('mem_1');
  });

  it('rejects duplicate ids and unknown updates', async () => {
    const members = repo.table('members');
    await members.insert({ id: 'mem_1', name: 'Ada', planId: 'p', status: 'active' });
    await expect(members.insert({ id: 'mem_1', name: 'Clone', planId: 'p', status: 'active' })).rejects.toThrow(
      /duplicate id/,
    );
    await expect(members.update('nope', { name: 'x' })).rejects.toThrow(/not found/);
  });

  it('returns defensive clones', async () => {
    const members = repo.table('members');
    await members.insert({ id: 'mem_1', name: 'Ada', planId: 'p', status: 'active', tags: ['a'] });
    const first = await members.findById('mem_1');
    first!.name = 'Mutated';
    first!.tags!.push('b');
    const second = await members.findById('mem_1');
    expect(second!.name).toBe('Ada');
    expect(second!.tags).toEqual(['a']);
  });

  it('orders, paginates and filters', async () => {
    const classes = repo.table('classes');
    for (let i = 0; i < 5; i += 1) {
      await classes.insert({
        id: `cls_${i}`,
        name: `Class ${i}`,
        instructorId: 'ins_1',
        startTime: new Date(Date.UTC(2026, 2, 2 + i)).toISOString(),
        capacity: 10,
      });
    }
    const ascending = await classes.list({ order: { field: 'startTime', dir: 'asc' } });
    expect(ascending.map((c) => c.id)).toEqual(['cls_0', 'cls_1', 'cls_2', 'cls_3', 'cls_4']);
    const descending = await classes.list({ order: { field: 'startTime', dir: 'desc' } });
    expect(descending[0]!.id).toBe('cls_4');

    const page = await classes.list({ order: { field: 'startTime' }, limit: 2, offset: 2 });
    expect(page.map((c) => c.id)).toEqual(['cls_2', 'cls_3']);
  });

  it('removes rows by id and by filter', async () => {
    const members = repo.table('members');
    await members.insertMany([
      { id: 'm1', name: 'A', planId: 'p', status: 'active' },
      { id: 'm2', name: 'B', planId: 'p', status: 'paused' },
      { id: 'm3', name: 'C', planId: 'p', status: 'active' },
    ]);
    expect(await members.remove('m1')).toBe(true);
    expect(await members.remove('nope')).toBe(false);
    expect(await members.removeWhere({ status: 'active' })).toBe(1);
    expect(await members.count()).toBe(1);
  });

  it('supports transactions', async () => {
    const result = await repo.transaction(async (tx) => {
      await tx.table('members').insert({ id: 'mem_tx', name: 'Tx', planId: 'p', status: 'active' });
      return 'done';
    });
    expect(result).toBe('done');
    expect(await repo.table('members').count()).toBe(1);
  });
});

describe('repository query over a real fixture', () => {
  it('filters the 32-booking fixture correctly', async () => {
    const h = harness();
    const ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
    const members = await seedMembers(h, 32);
    const fixture = await seedFixtureBookings(h, members);

    expect(fixture.bookings).toHaveLength(32);

    const bookings = ctx.repo.table('bookings');
    expect(await bookings.count()).toBe(32);
    expect(await bookings.count({ filter: { classId: fixture.classIds.full } })).toBe(16);
    expect(await bookings.count({ filter: { status: 'waitlisted' } })).toBe(6);
    expect(
      await bookings.count({
        filter: { classId: fixture.classIds.full, status: 'booked' },
      }),
    ).toBe(10);
  });
});