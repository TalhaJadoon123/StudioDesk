import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  EventBus,
  PLAN_CATALOG,
  formatMoney,
  GENERIC_500_MESSAGE,
  isAppError,
  limitsForTier,
  newBookingId,
  prefixedId,
  randomId,
  tierAtLeast,
  tierIndex,
  toErrorBody,
  uniqueBy,
  sortBy,
  chunk,
  groupBy,
  move,
} from '@studiodesk/shared';

describe('errors', () => {
  it('maps codes to HTTP statuses', () => {
    expect(new AppError('not_found', 'x').statusCode).toBe(404);
    expect(new AppError('validation_failed', 'x').statusCode).toBe(422);
    expect(new AppError('payment_failed', 'x').statusCode).toBe(402);
    expect(new AppError('class_full', 'x').statusCode).toBe(409);
    expect(new AppError('internal_error', 'x').statusCode).toBe(500);
  });

  it('serialises for the API', () => {
    const err = new AppError('conflict', 'Already booked', { bookingId: 'bkg_1' });
    expect(err.toJSON()).toEqual({
      error: 'conflict',
      message: 'Already booked',
      details: { bookingId: 'bkg_1' },
    });
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('nope'))).toBe(false);
  });

  it('never leaks internals from a 5xx', () => {
    // A client mistake is the caller's problem, so it is reported verbatim.
    const validation = toErrorBody(new AppError('validation_failed', 'name is required', { field: 'name' }));
    expect(validation.statusCode).toBe(422);
    expect(validation.body.message).toBe('name is required');

    // An unexpected bug is ours: the real message must not reach the browser.
    const crash = toErrorBody(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(crash.statusCode).toBe(500);
    expect(crash.body.message).toBe(GENERIC_500_MESSAGE);
    expect(JSON.stringify(crash.body)).not.toContain('10.0.0.5');
    expect(crash.body).not.toHaveProperty('stack');

    // Same for a 5xx AppError.
    const gateway = toErrorBody(new AppError('gateway_error', 'stripe key sk_live_... rejected'));
    expect(gateway.statusCode).toBe(502);
    expect(gateway.body.message).toBe(GENERIC_500_MESSAGE);
    expect(JSON.stringify(gateway.body)).not.toContain('sk_live_');
  });
});

describe('ids', () => {
  it('creates prefixed ids', () => {
    expect(newBookingId()).toMatch(/^bkg_[0-9a-z]{16}$/);
    expect(prefixedId('mem', 8)).toMatch(/^mem_[0-9a-z]{8}$/);
  });

  it('is random', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
  });
});

describe('plan catalog', () => {
  it('exposes the three published tiers', () => {
    expect(Object.keys(PLAN_CATALOG)).toEqual(['free', 'starter', 'business']);
    expect(PLAN_CATALOG.free.priceCents).toBe(0);
    expect(PLAN_CATALOG.starter.priceCents).toBe(3900);
    expect(PLAN_CATALOG.business.priceCents).toBe(9900);
  });

  it('limits the free tier to one class type', () => {
    expect(limitsForTier('free').maxClassTypes).toBe(1);
    expect(limitsForTier('starter').maxClassTypes).toBeNull();
  });

  it('gates paid features by tier', () => {
    expect(limitsForTier('free').waitlist).toBe(false);
    expect(limitsForTier('starter').waitlist).toBe(true);
    expect(limitsForTier('starter').churnAi).toBe(false);
    expect(limitsForTier('business').churnAi).toBe(true);
    expect(limitsForTier('business').dunning).toBe(true);
    expect(limitsForTier('business').maxMembers).toBeNull();
  });

  it('orders tiers', () => {
    expect(tierIndex('free')).toBe(0);
    expect(tierIndex('business')).toBe(2);
    expect(tierAtLeast('business', 'starter')).toBe(true);
    expect(tierAtLeast('free', 'starter')).toBe(false);
  });
});

describe('EventBus', () => {
  it('delivers events to subscribers', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('member.created', (payload) => {
      seen.push(payload.name);
    });
    await bus.emit('member.created', { memberId: 'mem_1', name: 'Ada' });
    expect(seen).toEqual(['Ada']);
  });

  it('supports unsubscribe and once', async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    // The handler must not return the array length (handlers are void-returning).
    const off = bus.on('member.created', () => {
      calls.push('a');
    });
    bus.once('member.created', () => {
      calls.push('once');
    });
    await bus.emit('member.created', { memberId: 'm', name: 'x' });
    off();
    await bus.emit('member.created', { memberId: 'm', name: 'x' });
    expect(calls).toEqual(['a', 'once']);
  });

  it('does not throw when there are no listeners', async () => {
    const bus = new EventBus();
    await expect(bus.emit('booking.created', {
      bookingId: 'b',
      memberId: 'm',
      classId: 'c',
    })).resolves.toBeUndefined();
  });

  it('supports async handlers', async () => {
    const bus = new EventBus();
    const spy = vi.fn(async () => {
      await Promise.resolve();
    });
    bus.on('member.cancelled', spy);
    await bus.emit('member.cancelled', { memberId: 'm' });
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('collection helpers', () => {
  it('dedupes by key', () => {
    expect(uniqueBy([{ a: 1 }, { a: 1 }, { a: 2 }], (x) => x.a)).toHaveLength(2);
  });

  it('sorts without mutating', () => {
    const input = [3, 1, 2];
    expect(sortBy(input, (n) => n)).toEqual([1, 2, 3]);
    expect(input).toEqual([3, 1, 2]);
    expect(sortBy(input, (n) => n, 'desc')).toEqual([3, 2, 1]);
  });

  it('chunks and groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(groupBy([{ k: 'a' }, { k: 'a' }, { k: 'b' }], (x) => x.k)).toEqual({
      a: [{ k: 'a' }, { k: 'a' }],
      b: [{ k: 'b' }],
    });
  });

  it('moves array items', () => {
    expect(move([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(move([1, 2, 3], 5, 0)).toEqual([1, 2, 3]);
  });
});

describe('formatMoney edge cases', () => {
  it('handles very large values', () => {
    expect(formatMoney(123_456_789)).toBe('$1,234,567.89');
  });
});