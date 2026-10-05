import { formatMoney, type Currency } from '@studiodesk/shared';

/** Presentation helpers shared by every page. */

export function money(cents: number | undefined, currency: Currency = 'usd'): string {
  return formatMoney(cents ?? 0, currency);
}

export function pct(value: number | undefined, digits = 0): string {
  if (value === undefined || Number.isNaN(value)) return '0%';
  return `${(value * 100).toFixed(digits)}%`;
}

/** `2026-03-02T18:30:00Z` -> `18:30`. */
export function time(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(11, 16);
}

/** `Mon 2 Mar` in UTC. */
export function day(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** `Mon 2 Mar, 18:30`. */
export function dayTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return `${day(iso)}, ${time(iso)}`;
}

/** Relative time for activity feeds: `4m ago`. */
export function ago(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const seconds = Math.round((now.getTime() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Countdown to a class: `in 2h 15m`, `started`, `done`. */
export function countdown(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const diff = Date.parse(iso) - now.getTime();
  if (diff <= 0) return 'started';
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.round((diff % 3_600_000) / 60_000);
  if (hours === 0) return `in ${minutes}m`;
  return `in ${hours}h ${minutes}m`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

/** Colour band for a 0..1 risk score. */
export function riskTone(risk: number): 'ok' | 'warn' | 'danger' {
  if (risk >= 0.75) return 'danger';
  if (risk >= 0.5) return 'warn';
  return 'ok';
}

/** Colour band for a 0..1 fill rate. */
export function fillTone(fill: number): 'good' | 'full' | '' {
  if (fill >= 1) return 'full';
  if (fill >= 0.8) return 'good';
  return '';
}
