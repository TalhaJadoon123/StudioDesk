/** Formatting helpers shared by the mobile screens. */

export function time(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(11, 16);
}

export function day(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function dayTime(iso?: string): string {
  if (!iso) return '';
  return `${day(iso)} at ${time(iso)}`;
}

export function when(iso?: string, now: Date = new Date()): string {
  if (!iso) return '';
  const diff = Date.parse(iso) - now.getTime();
  if (diff <= 0) return 'started';
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.round((diff % 3_600_000) / 60_000);
  if (hours === 0) return `in ${minutes}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
}

export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(Math.floor(abs / 100)).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

/** ISO dates for the next `days` days, starting today (UTC). */
export function upcomingDays(
  days = 14,
  now: Date = new Date(),
): Array<{ iso: string; label: string; weekday: string; isToday: boolean }> {
  const out: Array<{ iso: string; label: string; weekday: string; isToday: boolean }> = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(now.getTime() + i * 86_400_000);
    out.push({
      iso: date.toISOString(),
      label: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      weekday: date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      isToday: i === 0,
    });
  }
  return out;
}

/** Unique idempotency key for a purchase, so a double tap cannot double-charge. */
export function purchaseKey(memberId: string, kind: string): string {
  return `${kind}-${memberId}-${Date.now().toString(36)}`;
}
