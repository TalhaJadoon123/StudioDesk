import 'server-only';
import { createStudioDesk, type StudioDesk } from '@studiodesk/core';

/**
 * A single StudioDesk instance per server process.
 *
 * Next's dev server re-evaluates modules on every hot reload, so the desk is
 * memoised on `globalThis` to avoid leaking in-memory repositories (and event
 * listeners) between reloads.
 */

const GLOBAL_KEY = Symbol.for('studiodesk.desk');

type GlobalWithDesk = typeof globalThis & { [GLOBAL_KEY]?: StudioDesk };

export function getDesk(): StudioDesk {
  const globalRef = globalThis as GlobalWithDesk;
  if (!globalRef[GLOBAL_KEY]) {
    globalRef[GLOBAL_KEY] = createStudioDesk();
  }
  return globalRef[GLOBAL_KEY]!;
}

/** The repository driver in use, for the health endpoint. */
export function driverName(): string {
  return getDesk().ctx.repo.kind;
}

/** Whether Supabase is configured (drives the "connect your database" banner). */
export function usingMemory(): boolean {
  return getDesk().ctx.repo.kind === 'memory';
}
