import { describe, expect, it } from 'vitest';
import { formatMoney, toCents } from '@studiodesk/shared';
import { MemoryRepository } from '@studiodesk/core';

describe('smoke', () => {
  it('resolves workspace packages and formats money', () => {
    expect(formatMoney(3900)).toBe('$39.00');
    expect(toCents('39.00')).toBe(3900);
  });

  it('boots an in-memory repository', async () => {
    const repo = new MemoryRepository();
    await repo.table('members').insert({ id: 'mem_1', name: 'Ada', planId: 'p1', status: 'active' });
    expect(await repo.table('members').count()).toBe(1);
  });
});