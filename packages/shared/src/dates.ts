/**
 * Minimal, dependency-free date helpers. Every function that returns a string
 * returns an ISO-8601 UTC timestamp unless it is explicitly named `dateOnly`.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function nowIso(): string {
  return new Date().toISOString();
}

export function iso(value: Date | string | number): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function parse(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export function addMinutes(value: Date | string, minutes: number): Date {
  return new Date(parse(value).getTime() + minutes * MINUTE_MS);
}

export function addHours(value: Date | string, hours: number): Date {
  return new Date(parse(value).getTime() + hours * HOUR_MS);
}

export function addDays(value: Date | string, days: number): Date {
  return new Date(parse(value).getTime() + days * DAY_MS);
}

export function addMonths(value: Date | string, months: number): Date {
  const d = parse(value);
  const target = new Date(d.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  // Clamp to the last valid day (Jan 31 + 1 month -> Feb 28/29).
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

export function startOfDay(value: Date | string): Date {
  const d = parse(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function endOfDay(value: Date | string): Date {
  return new Date(startOfDay(value).getTime() + DAY_MS - 1);
}

export function startOfWeek(value: Date | string, weekStartsOn = 1): Date {
  const d = startOfDay(value);
  const diff = (d.getUTCDay() - weekStartsOn + 7) % 7;
  return new Date(d.getTime() - diff * DAY_MS);
}

export function startOfMonth(value: Date | string): Date {
  const d = parse(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function endOfMonth(value: Date | string): Date {
  const d = parse(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export function daysBetween(a: Date | string, b: Date | string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / DAY_MS);
}

export function hoursUntil(target: Date | string, from: Date | string = new Date()): number {
  return (parse(target).getTime() - parse(from).getTime()) / HOUR_MS;
}

export function isPast(value: Date | string, now: Date | string = new Date()): boolean {
  return parse(value).getTime() < parse(now).getTime();
}

export function isSameDay(a: Date | string, b: Date | string): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/** `YYYY-MM-DD` in UTC. */
export function dateOnly(value: Date | string = new Date()): string {
  return parse(value).toISOString().slice(0, 10);
}

/** Monday-first weekday index: Monday = 0 ... Sunday = 6. */
export function weekdayIndex(value: Date | string): number {
  return (parse(value).getUTCDay() + 6) % 7;
}

export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export function weekdayCode(value: Date | string): (typeof WEEKDAY_CODES)[number] {
  return WEEKDAY_CODES[weekdayIndex(value)]!;
}

export function toLocalIso(d: Date, timeZone: string): string {
  // en-CA renders as YYYY-MM-DD which makes the string surgery trivial.
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(d)
      .replace(',', '');
  } catch {
    return d.toISOString();
  }
}

export function formatRange(from: Date | string, to: Date | string): string {
  return `${dateOnly(from)} .. ${dateOnly(to)}`;
}