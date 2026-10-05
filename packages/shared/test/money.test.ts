import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  toCents,
  sum,
  percent,
  currencySymbol,
  clampCents,
} from '@studiodesk/shared';

describe('money', () => {
  it('formats cents as currency', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(3900)).toBe('$39.00');
    expect(formatMoney(150000)).toBe('$1,500.00');
    expect(formatMoney(-250)).toBe('-$2.50');
  });

  it('supports other currencies', () => {
    expect(formatMoney(8900, 'eur')).toBe('\u20ac89.00');
    expect(formatMoney(8900, 'gbp')).toBe('\u00a389.00');
    expect(formatMoney(8900, 'pkr')).toBe('\u20a889.00');
    expect(currencySymbol('pkr')).toBe('\u20a8');
  });

  it('parses amounts into cents', () => {
    expect(toCents(39)).toBe(3900);
    expect(toCents(39.99)).toBe(3999);
    expect(toCents('39.00')).toBe(3900);
    expect(toCents('$1,200.50')).toBe(120_050);
    expect(toCents('')).toBe(0);
    expect(toCents('abc')).toBe(0);
  });

  it('never stores floats as money', () => {
    // The classic 0.1 + 0.2 bug, in the right currency.
    expect(toCents(0.1) + toCents(0.2)).toBe(toCents(0.3));
  });

  it('provides small helpers', () => {
    expect(sum([100, 200, 300])).toBe(600);
    expect(percent(1, 3)).toBe(33);
    expect(percent(1, 3, 1)).toBe(33.3);
    expect(percent(1, 0)).toBe(0);
    expect(clampCents(-5)).toBe(0);
    expect(clampCents(500.4)).toBe(500);
  });
});