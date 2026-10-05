/** Small assertion / collection helpers used across every package. */

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function uniqueBy<T, K>(items: T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function groupBy<T, K extends string | number>(
  items: T[],
  key: (item: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function sortBy<T>(items: T[], key: (item: T) => number | string, dir: 'asc' | 'desc' = 'asc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) return 0;
    return (ka < kb ? -1 : 1) * sign;
  });
}

export function move<T>(items: T[], from: number, to: number): T[] {
  const out = [...items];
  const [item] = out.splice(from, 1);
  if (item === undefined) return out;
  out.splice(to, 0, item);
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lazily evaluated with a de-duplicating in-flight guard. */
export function memoizeAsync<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const inflight = new Map<string, Promise<R>>();
  return (...args: A): Promise<R> => {
    const key = JSON.stringify(args);
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = fn(...args).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}