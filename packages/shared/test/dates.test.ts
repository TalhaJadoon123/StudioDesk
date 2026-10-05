import { describe, expect, it } from 'vitest';
import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  dateOnly,
  daysBetween,
  endOfDay,
  hoursUntil,
  isPast,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
  weekdayCode,
  weekdayIndex,
} from '@studiodesk/shared';

const MON_2026_03_02 = new Date('2026-03-02T09:00:00.000Z');

describe('dates', () => {
  it('adds time without mutating the input', () => {
    const start = new Date(MON_2026_03_02);
    expect(addMinutes(start, 90).toISOString()).toBe('2026-03-02T10:30:00.000Z');
    expect(addHours(start, -3).toISOString()).toBe('2026-03-02T06:00:00.000Z');
    expect(addDays(start, 1).toISOString()).toBe('2026-03-03T09:00:00.000Z');
    expect(start.toISOString()).toBe(MON_2026_03_02.toISOString());
  });

  it('clamps month arithmetic to valid days', () => {
    const jan31 = new Date('2026-01-31T12:00:00.000Z');
    expect(addMonths(jan31, 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    // 2028 is a leap year.
    const jan31_2028 = new Date('2028-01-31T12:00:00.000Z');
    expect(addMonths(jan31_2028, 1).toISOString().slice(0, 10)).toBe('2028-02-29');
    expect(addMonths(MON_2026_03_02, 12).toISOString().slice(0, 10)).toBe('2027-03-02');
  });

  it('truncates to day boundaries in UTC', () => {
    expect(startOfDay(MON_2026_03_02).toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(endOfDay(MON_2026_03_02).toISOString()).toBe('2026-03-02T23:59:59.999Z');
    expect(dateOnly(MON_2026_03_02)).toBe('2026-03-02');
  });

  it('finds the start of the week (Monday-first)', () => {
    // 2026-03-02 is a Monday.
    expect(startOfWeek(MON_2026_03_02).toISOString()).toBe('2026-03-02T00:00:00.000Z');
    // Sunday belongs to the week that started the previous Monday.
    const sunday = new Date('2026-03-08T15:00:00.000Z');
    expect(startOfWeek(sunday).toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('finds the start of the month', () => {
    expect(startOfMonth(MON_2026_03_02).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('computes differences', () => {
    expect(daysBetween('2026-03-01', '2026-03-08')).toBe(7);
    expect(daysBetween('2026-03-08', '2026-03-01')).toBe(-7);
    expect(hoursUntil('2026-03-02T12:00:00.000Z', '2026-03-02T09:00:00.000Z')).toBe(3);
    expect(hoursUntil('2026-03-02T06:00:00.000Z', '2026-03-02T09:00:00.000Z')).toBe(-3);
  });

  it('answers comparison questions', () => {
    expect(isPast('2026-03-01', MON_2026_03_02)).toBe(true);
    expect(isPast('2026-03-03', MON_2026_03_02)).toBe(false);
    expect(isSameDay('2026-03-02T00:00:00.000Z', '2026-03-02T23:59:59.000Z')).toBe(true);
    expect(isSameDay('2026-03-02', '2026-03-03')).toBe(false);
  });

  it('maps weekdays Monday-first', () => {
    expect(weekdayIndex('2026-03-02')).toBe(0); // Monday
    expect(weekdayIndex('2026-03-08')).toBe(6); // Sunday
    expect(weekdayCode('2026-03-02')).toBe('MO');
    expect(weekdayCode('2026-03-08')).toBe('SU');
  });
});