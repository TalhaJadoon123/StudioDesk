import type { Currency } from './types.js';

const ZERO_DECIMAL: Currency[] = [];

export const CURRENCY_SYMBOL: Record<Currency, string> = {
  usd: '$',
  eur: '\u20ac',
  gbp: '\u00a3',
  pkr: '\u20a8',
};

export function currencySymbol(currency: Currency = 'usd'): string {
  return CURRENCY_SYMBOL[currency] ?? '$';
}

/** `3900` -> `"$39.00"`. */
export function formatMoney(cents: number, currency: Currency = 'usd'): string {
  const symbol = currencySymbol(currency);
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${frac}`;
}

/** `"39.00"` / `39` / `"$39"` -> `3900`. Rounds to the nearest cent. */
export function toCents(amount: number | string): number {
  if (typeof amount === 'number') return Math.round(amount * 100);
  const cleaned = String(amount).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  return Math.round(Number.parseFloat(cleaned) * 100);
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

export function clampCents(cents: number, min = 0): number {
  return Math.max(min, Math.round(cents));
}

export function percent(part: number, whole: number, digits = 0): number {
  if (!whole) return 0;
  const value = (part / whole) * 100;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function isZeroDecimal(currency: Currency): boolean {
  return ZERO_DECIMAL.includes(currency);
}