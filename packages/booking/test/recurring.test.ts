import { describe, expect, it } from 'vitest';
import {
  RRuleError,
  buildRRule,
  describeRRule,
  describeSchedule,
  expandOccurrences,
  expandRRule,
  isValidRRule,
  parseRRule,
  untilDate,
  weeklyRule,
} from '@studiodesk/booking';

const MON_MAR_02 = '2026-03-02T09:00:00.000Z';

describe('parseRRule', () => {
  it('parses a weekly rule', () => {
    const rule = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12');
    expect(rule.freq).toBe('WEEKLY');
    expect(rule.byDay).toEqual(['MO', 'WE', 'FR']);
    expect(rule.count).toBe(12);
    expect(rule.interval).toBe(1);
  });

  it('accepts long weekday names and strips ordinals', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MONDAY').byDay).toEqual(['MO']);
    // Ordinals (2MO) are not supported but must not corrupt the parse.
    expect(parseRRule('FREQ=WEEKLY;BYDAY=2MO,WE').byDay).toEqual(['MO', 'WE']);
  });

  it('parses UNTIL in both formats', () => {
    // Stored as a full ISO timestamp; `untilDate` is the date-only view.
    expect(untilDate('FREQ=DAILY;UNTIL=20260401')).toBe('2026-04-01');
    expect(untilDate('FREQ=DAILY;UNTIL=20260401T000000Z')).toBe('2026-04-01');
    expect(parseRRule('FREQ=DAILY;UNTIL=20260401').until).toBe('2026-04-01T00:00:00.000Z');
  });

  it('tolerates the RRULE: prefix', () => {
    expect(parseRRule('RRULE:FREQ=DAILY').freq).toBe('DAILY');
  });

  it('rejects nonsense', () => {
    expect(() => parseRRule('FREQ=HOURLY')).toThrow(RRuleError);
    expect(() => parseRRule('FREQ=WEEKLY;INTERVAL=0')).toThrow(/INTERVAL/);
    expect(() => parseRRule('')).toThrow(/Empty/);
    expect(isValidRRule('FREQ=DAILY')).toBe(true);
    expect(isValidRRule('nope')).toBe(false);
  });
});

describe('buildRRule', () => {
  it('round-trips through parseRRule', () => {
    const rule = buildRRule({ freq: 'WEEKLY', byDay: ['MO', 'TH'], interval: 2, count: 8 });
    const parsed = parseRRule(rule);
    expect(parsed.freq).toBe('WEEKLY');
    expect(parsed.byDay).toEqual(['MO', 'TH']);
    expect(parsed.interval).toBe(2);
    expect(parsed.count).toBe(8);
  });

  it('omits defaults', () => {
    expect(buildRRule({ freq: 'DAILY' })).toBe('FREQ=DAILY');
    expect(weeklyRule([1, 3, 5])).toBe('FREQ=WEEKLY;BYDAY=TU,TH,SA');
  });
});

describe('expandRRule', () => {
  it('expands a weekly rule from DTSTART', () => {
    const occurrences = expandRRule('DTSTART:20260302T090000Z\nFREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6', {
      to: '2026-04-30T00:00:00Z',
    });
    expect(occurrences).toHaveLength(6);
    expect(occurrences[0]!.startTime).toBe('2026-03-02T09:00:00.000Z');
    expect(occurrences[1]!.startTime).toBe('2026-03-04T09:00:00.000Z');
    expect(occurrences[2]!.startTime).toBe('2026-03-06T09:00:00.000Z');
    expect(occurrences[3]!.startTime).toBe('2026-03-09T09:00:00.000Z');
  });

  it('respects the window', () => {
    const occurrences = expandRRule('FREQ=DAILY', {
      from: '2026-03-02T00:00:00Z',
      to: '2026-03-06T23:59:59Z',
      time: { hour: 18, minute: 30 },
    });
    expect(occurrences).toHaveLength(5);
    expect(occurrences[0]!.startTime).toBe('2026-03-02T18:30:00.000Z');
    expect(occurrences[4]!.startTime).toBe('2026-03-06T18:30:00.000Z');
  });

  it('honours INTERVAL for fortnightly rules', () => {
    const occurrences = expandRRule('DTSTART:20260302T090000Z\nFREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=6');
    const days = occurrences.map((o) => o.startTime.slice(0, 10));
    expect(days).toEqual([
      '2026-03-03', // Tue week 1
      '2026-03-05', // Thu week 1
      '2026-03-17', // Tue week 3
      '2026-03-19', // Thu week 3
      '2026-03-31', // Tue week 5
      '2026-04-02', // Thu week 5
    ]);
  });

  it('stops at UNTIL', () => {
    const occurrences = expandRRule('DTSTART:20260302T090000Z\nFREQ=DAILY;UNTIL=20260305T000000Z');
    expect(occurrences).toHaveLength(3);
  });

  it('handles monthly BYMONTHDAY', () => {
    const occurrences = expandRRule('DTSTART:20260101T090000Z\nFREQ=MONTHLY;BYMONTHDAY=15;COUNT=4');
    expect(occurrences.map((o) => o.startTime.slice(0, 10))).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ]);
  });

  it('clamps monthly rules to short months', () => {
    const occurrences = expandRRule('DTSTART:20260131T090000Z\nFREQ=MONTHLY;COUNT=3');
    expect(occurrences.map((o) => o.startTime.slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
  });

  it('respects a hard limit', () => {
    const occurrences = expandRRule('FREQ=DAILY', { from: MON_MAR_02, limit: 5 });
    expect(occurrences).toHaveLength(5);
  });

  it('derives end times from the duration', () => {
    const [first] = expandOccurrences('DTSTART:20260302T090000Z\nFREQ=WEEKLY;BYDAY=MO;COUNT=1', {
      durationMinutes: 75,
    });
    expect(first!.startTime).toBe('2026-03-02T09:00:00.000Z');
    expect(first!.endTime).toBe('2026-03-02T10:15:00.000Z');
  });
});

describe('descriptions', () => {
  it('describes weekly rules in plain English', () => {
    expect(describeRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toBe('Mon, Wed, Fri');
    expect(describeRRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Weekdays');
    expect(describeRRule('FREQ=WEEKLY;BYDAY=SA,SU')).toBe('Every weekend');
    expect(describeRRule('FREQ=DAILY')).toBe('Daily');
    expect(describeRRule('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('Day 15 of every month');
  });

  it('describes a whole schedule with its time', () => {
    expect(describeSchedule('FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-03-02T07:00:00.000Z')).toBe(
      'Mon, Wed, Fri at 07:00',
    );
    expect(describeSchedule('FREQ=DAILY', '2026-03-02T18:30:00.000Z')).toBe('Daily at 18:30');
  });
});