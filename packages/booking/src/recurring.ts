import {
  DAY_MS,
  WEEKDAY_CODES,
  WEEKDAY_NAMES,
  addDays,
  parse,
  startOfDay,
  weekdayIndex,
} from '@studiodesk/shared';

/**
 * A small, dependency-free RRULE implementation covering what a studio needs to
 * run a weekly timetable: FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL, BYDAY,
 * BYMONTHDAY, COUNT, UNTIL and WKST.
 *
 * Not a full RFC 5545 parser - `BYDAY` indices such as `2MO` (second Monday)
 * are parsed and then ignored rather than silently mis-scheduled.
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type Weekday = (typeof WEEKDAY_CODES)[number];

export interface ParsedRRule {
  freq: Frequency;
  interval: number;
  byDay: Weekday[];
  /** Monthly rules only: 1-31, negative counts from the end. */
  byMonthDay: number[];
  byMonth: number[];
  count?: number;
  until?: string;
  wkst: Weekday;
  /** Present when the rule carried a DTSTART. */
  dtstart?: string;
}

export interface Occurrence {
  startTime: string;
  endTime: string;
  index: number;
}

export const WEEKDAY_BY_NAME: Record<string, Weekday> = {
  MO: 'MO',
  TU: 'TU',
  WE: 'WE',
  TH: 'TH',
  FR: 'FR',
  SA: 'SA',
  SU: 'SU',
  MONDAY: 'MO',
  TUESDAY: 'TU',
  WEDNESDAY: 'WE',
  THURSDAY: 'TH',
  FRIDAY: 'FR',
  SATURDAY: 'SA',
  SUNDAY: 'SU',
};

export class RRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RRuleError';
  }
}

/** Parses `FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=52` (DTSTART optional). */
export function parseRRule(input: string): ParsedRRule {
  if (!input || !input.trim()) throw new RRuleError('Empty RRULE');
  const normalised = input.trim().replace(/^RRULE:/i, '');

  const parts: Record<string, string> = {};
  // RFC 5545 separates parts with `;`, but DTSTART is conventionally on its
  // own line. Accept both.
  for (const chunk of normalised.split(/[;\r\n]+/)) {
    if (!chunk.trim()) continue;
    const [key, ...rest] = chunk.split('=');
    if (!key) continue;
    parts[key.trim().toUpperCase()] = rest.join('=').trim();
  }

  const freqRaw = (parts.FREQ ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freqRaw)) {
    throw new RRuleError(`Unsupported FREQ "${parts.FREQ ?? ''}" (use DAILY, WEEKLY, MONTHLY or YEARLY)`);
  }

  const interval = Number.parseInt(parts.INTERVAL ?? '1', 10);
  if (!Number.isFinite(interval) || interval < 1) throw new RRuleError(`Invalid INTERVAL "${parts.INTERVAL}"`);

  const byDay: Weekday[] = [];
  for (const raw of (parts.BYDAY ?? '').split(',').filter(Boolean)) {
    // Strip an ordinal prefix (2MO, -1FR) - ordinals are not supported.
    const code = raw.toUpperCase().replace(/^[+-]?\d+/, '');
    const weekday = WEEKDAY_BY_NAME[code];
    if (!weekday) throw new RRuleError(`Invalid BYDAY entry "${raw}"`);
    if (!byDay.includes(weekday)) byDay.push(weekday);
  }

  const byMonthDay = (parts.BYMONTHDAY ?? '')
    .split(',')
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value !== 0);

  const byMonth = (parts.BYMONTH ?? '')
    .split(',')
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));

  const count = parts.COUNT ? Number.parseInt(parts.COUNT, 10) : undefined;
  if (count !== undefined && (!Number.isFinite(count) || count < 1)) {
    throw new RRuleError(`Invalid COUNT "${parts.COUNT}"`);
  }

  const until = parts.UNTIL ? normaliseDate(parts.UNTIL) : undefined;
  const wkst = (WEEKDAY_BY_NAME[(parts.WKST ?? 'MO').toUpperCase()] ?? 'MO') as Weekday;

  return {
    freq: freqRaw as Frequency,
    interval,
    byDay,
    byMonthDay,
    byMonth,
    count,
    until,
    wkst,
    dtstart: parts.DTSTART ? normaliseDate(parts.DTSTART) : undefined,
  };
}

function normaliseDate(value: string): string {
  // Accept 20260101, 20260101T090000Z, 2026-01-01 and full ISO timestamps.
  const compact = value.replace(/Z$/, '').trim();
  const basic = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/.exec(compact);
  if (basic) {
    const [, year, month, day, hour = '00', minute = '00', second = '00'] = basic;
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) throw new RRuleError(`Invalid date "${value}"`);
    return parsed.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RRuleError(`Invalid date "${value}"`);
  return parsed.toISOString();
}

/** Builds an RRULE string. The inverse of `parseRRule` for our own output. */
export function buildRRule(input: {
  freq: Frequency;
  interval?: number;
  byDay?: Weekday[];
  byMonthDay?: number[];
  count?: number;
  until?: string | Date;
  wkst?: Weekday;
}): string {
  const parts = [`FREQ=${input.freq}`];
  if (input.interval && input.interval !== 1) parts.push(`INTERVAL=${input.interval}`);
  if (input.byDay?.length) parts.push(`BYDAY=${input.byDay.join(',')}`);
  if (input.byMonthDay?.length) parts.push(`BYMONTHDAY=${input.byMonthDay.join(',')}`);
  if (input.count) parts.push(`COUNT=${input.count}`);
  if (input.until) parts.push(`UNTIL=${(typeof input.until === 'string' ? input.until : input.until.toISOString()).replace(/[-:]|\.\d{3}/g, '')}`);
  if (input.wkst) parts.push(`WKST=${input.wkst}`);
  return parts.join(';');
}

/** "Every Monday, Wednesday and Friday" -> a WEEKLY rule. */
export function weeklyRule(weekdays: Array<0 | 1 | 2 | 3 | 4 | 5 | 6>, options: { until?: Date; count?: number; interval?: number } = {}): string {
  return buildRRule({
    freq: 'WEEKLY',
    interval: options.interval ?? 1,
    byDay: weekdays.map((d) => WEEKDAY_CODES[d]!),
    until: options.until,
    count: options.count,
  });
}

/**
 * Pulls DTSTART out of a raw rule string.
 *
 * RFC 5545 puts DTSTART in its own line, so `parseRRule` only sees it when it
 * is written as a `;`-separated pair. This recovers it either way.
 */
function findDtstart(raw: string): string | undefined {
  const match = /DTSTART[:=]?\s*([0-9TZ]+)/i.exec(raw);
  if (!match?.[1]) return undefined;
  try {
    return normaliseDate(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * `until` is normalised to a full ISO timestamp internally so comparisons in
 * `expandRRule` are simple; this returns the date-only form for display.
 */
export function untilDate(rule: string | ParsedRRule): string | undefined {
  const parsed = typeof rule === 'string' ? parseRRule(rule) : rule;
  return parsed.until?.slice(0, 10);
}

export function describeRRule(rule: string): string {
  const parsed = parseRRule(rule);
  // A plain DAILY rule with no BYDAY is just "Daily".
  if (parsed.freq === 'DAILY' && parsed.interval === 1 && !parsed.byMonthDay.length) {
    return parsed.count ? `Daily, ${parsed.count} times` : 'Daily';
  }

  const unit = parsed.freq === 'DAILY' ? 'day' : parsed.freq === 'WEEKLY' ? 'week' : 'month';
  const every =
    parsed.interval === 1 ? `Every ${unit}` : `Every ${parsed.interval} ${unit}s`;

  if (parsed.byDay.length) {
    const names = parsed.byDay
      .map((code) => ({ code, index: WEEKDAY_CODES.indexOf(code) }))
      .sort((a, b) => a.index - b.index)
      .map(({ code }) => WEEKDAY_NAMES[WEEKDAY_CODES.indexOf(code)]?.slice(0, 3) ?? code);
    if (names.length === 7) return 'Daily';
    if (parsed.byDay.length === 5 && parsed.freq === 'WEEKLY') return 'Weekdays';
    if (parsed.byDay.length === 2 && parsed.byDay.includes('SA') && parsed.byDay.includes('SU')) {
      return 'Every weekend';
    }
    return `${names.join(', ')}`;
  }
  if (parsed.byMonthDay.length && parsed.freq === 'MONTHLY') {
    const day = parsed.byMonthDay[0]!;
    return day === -1 ? 'Last day of the month' : `Day ${day} of every month`;
  }
  const suffix = parsed.count ? `, ${parsed.count} times` : parsed.until ? `, until ${parsed.until.slice(0, 10)}` : '';
  return `${every}${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* Expansion                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExpandOptions {
  /** First occurrence. Defaults to the rule's DTSTART, else `from`. */
  from?: string | Date;
  to?: string | Date;
  /** Hard cap so a bad rule cannot run forever. */
  limit?: number;
  /** Time of day to stamp on each occurrence (UTC). */
  time?: { hour: number; minute: number; second?: number };
}

function stampTime(date: Date, time?: ExpandOptions['time']): Date {
  const out = new Date(date.getTime());
  if (time) {
    out.setUTCHours(time.hour, time.minute, time.second ?? 0, 0);
  } else {
    out.setUTCHours(0, 0, 0, 0);
  }
  return out;
}

function matchesByDay(date: Date, parsed: ParsedRRule): boolean {
  if (!parsed.byDay.length) return true;
  return parsed.byDay.includes(WEEKDAY_CODES[weekdayIndex(date)]!);
}

function matchesMonth(date: Date, parsed: ParsedRRule): boolean {
  if (!parsed.byMonth.length) return true;
  return parsed.byMonth.includes(date.getUTCMonth() + 1);
}

function monthDay(date: Date, days: number[]): boolean {
  if (!days.length) return true;
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return days.some((day) => (day > 0 ? day : lastDay + day + 1) === date.getUTCDate());
}

/**
 * Expands a rule into concrete occurrences.
 *
 * Weekly rules anchor on the week containing DTSTART and honour INTERVAL, so
 * `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH` lands on the right fortnightly days.
 */
export function expandRRule(rule: string | ParsedRRule, options: ExpandOptions = {}): Occurrence[] {
  const inputRuleString = typeof rule === 'string' ? rule : undefined;
  const parsed = typeof rule === 'string' ? parseRRule(rule) : rule;
  // The series is anchored to DTSTART when present (so INTERVAL maths is
  // stable), but the expansion *window* always starts at `from` when given.
  // `DTSTART:20260302T090000Z` may arrive as a separate line, so fall back to
  // re-parsing when the field is missing.
  const anchorStart =
    parsed.dtstart ??
    (inputRuleString ? findDtstart(inputRuleString) : undefined) ??
    (options.from ? parse(options.from).toISOString() : undefined);
  if (!anchorStart) {
    throw new RRuleError('expandRRule needs DTSTART in the rule or a `from` option');
  }

  const phase = parse(anchorStart);
  const windowStart = options.from ? parse(options.from) : phase;
  const windowEnd = options.to ? parse(options.to) : undefined;
  const until = parsed.until ? parse(parsed.until) : undefined;
  const limit = options.limit ?? 500;
  const results: Occurrence[] = [];
  let index = 0;

  // `index` counts every occurrence the rule generates (including any before
  // the window), so COUNT stays anchored to DTSTART rather than to `from`.
  let generated = 0;

  const emit = (candidate: Date): boolean => {
    const start = stampTime(candidate, options.time ?? {
      hour: phase.getUTCHours(),
      minute: phase.getUTCMinutes(),
      second: phase.getUTCSeconds(),
    });
    if (until && start.getTime() > until.getTime()) return false;
    if (parsed.count && generated >= parsed.count) return false;

    generated += 1;

    // Outside the requested window: count it, but do not return it.
    if (start.getTime() < windowStart.getTime()) return true;
    if (windowEnd && start.getTime() > windowEnd.getTime()) return false;

    results.push({ startTime: start.toISOString(), endTime: start.toISOString(), index: generated });
    return results.length < limit && (!parsed.count || generated < parsed.count);
  };

  if (parsed.freq === 'WEEKLY' && parsed.byDay.length) {
    // Align to the week start (wkst) of the anchor, then step by INTERVAL weeks.
    const weekStart = startOfWeekAligned(phase, parsed.wkst);
    const daysOffset = parsed.byDay
      .map((code) => (WEEKDAY_CODES.indexOf(code) - WEEKDAY_CODES.indexOf(parsed.wkst) + 7) % 7)
      .sort((a, b) => a - b);

    let cursor = weekStart;
    // Skip whole weeks before the window so a long-running series stays fast.
    // `generated` still has to keep pace with COUNT.
    let guard = 0;
    while (generated + daysOffset.length <= (parsed.count ?? Infinity) && guard < 100_000) {
      guard += 1;
      const weekEnd = addDays(cursor, 7);
      const weekIsBeforeWindow = weekEnd.getTime() < windowStart.getTime();
      if (!weekIsBeforeWindow) {
        for (const offset of daysOffset) {
          if (!emit(addDays(cursor, offset))) return results;
        }
      } else {
        generated += daysOffset.length;
      }
      cursor = addDays(cursor, 7 * parsed.interval);
      if (windowEnd && cursor.getTime() > windowEnd.getTime()) break;
      if (until && cursor.getTime() > until.getTime()) break;
    }
    return results;
  }

  const step =
    parsed.freq === 'DAILY'
      ? (d: Date) => addDays(d, parsed.interval)
      : parsed.freq === 'MONTHLY'
        ? (d: Date) => addMonthsLocal(d, parsed.interval)
        : (d: Date) => addMonthsLocal(d, parsed.interval * 12);

  // For MONTHLY/YEARLY rules the cursor walks months. The day-of-month is
  // re-applied with clamping on every step, so an end-of-month anchor
  // (Jan 31) lands on Feb 28, Mar 31, ... rather than freezing on the 1st.
  const anchorDay = phase.getUTCDate();
  let cursor = startOfDay(phase);
  let guard = 0;

  while (results.length < limit && guard < 5000) {
    guard += 1;

    // DAILY rules step by day and match every day; MONTHLY/YEARLY need the
    // target day applied before matching.
    const candidate =
      parsed.freq === 'DAILY'
        ? cursor
        : parsed.byMonthDay.length
          ? setDayOfMonth(cursor, parsed.byMonthDay[0]!)
          : setDayOfMonth(cursor, anchorDay);

    const dayMatches = matchesMonth(candidate, parsed);

    if (dayMatches) {
      const stopped = emit(candidate);
      if (!stopped) break;
    }

    if (windowEnd && candidate.getTime() > windowEnd.getTime() + 31 * DAY_MS) break;
    if (until && candidate.getTime() > until.getTime() + 31 * DAY_MS) break;

    const next = step(cursor);
    if (next.getTime() <= cursor.getTime()) break;
    cursor = next;
  }
  return results;
}

/** Sets the day-of-month, clamping to the month's length. */
function setDayOfMonth(date: Date, desiredDay: number): Date {
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const out = new Date(date.getTime());
  out.setUTCDate(Math.min(desiredDay, lastDay));
  return out;
}

function startOfWeekAligned(date: Date, wkst: Weekday): Date {
  const start = startOfDay(date);
  const offset = (WEEKDAY_CODES.indexOf(WEEKDAY_CODES[weekdayIndex(start)]!) - WEEKDAY_CODES.indexOf(wkst) + 7) % 7;
  return addDays(start, -offset);
}

function addMonthsLocal(date: Date, months: number): Date {
  // Advance via the first of the month so an end-of-month anchor (Jan 31)
  // cannot drift: the target day is re-applied with clamping by the caller.
  const out = new Date(date.getTime());
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/** Occurrences with an end time derived from the class duration. */
export function expandOccurrences(
  rule: string,
  options: ExpandOptions & { durationMinutes: number },
): Array<{ startTime: string; endTime: string; index: number }> {
  return expandRRule(rule, options).map((occurrence) => ({
    ...occurrence,
    endTime: new Date(Date.parse(occurrence.startTime) + options.durationMinutes * 60_000).toISOString(),
  }));
}

/** Human label for the picker: "Mon, Wed, Fri at 07:00". */
export function describeSchedule(rule: string, startTimeIso: string): string {
  const time = new Date(startTimeIso).toISOString().slice(11, 16);
  const parsed = parseRRule(rule);
  let days = 'Daily';
  if (parsed.byDay.length) {
    const indexes = parsed.byDay.map((code) => WEEKDAY_CODES.indexOf(code)).sort((a, b) => a - b);
    const names = indexes.map((i) => WEEKDAY_NAMES[i]!.slice(0, 3));
    days =
      indexes.length === 7
        ? 'Daily'
        : indexes.length === 5
          ? 'Weekdays'
          : names.join(', ');
  }
  return `${days} at ${time}`;
}

export function isValidRRule(rule: string): boolean {
  try {
    parseRRule(rule);
    return true;
  } catch {
    return false;
  }
}

export { WEEKDAY_CODES, WEEKDAY_NAMES };