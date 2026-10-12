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

const globalRef = globalThis as GlobalWithDesk;

/**
 * Get the StudioDesk instance, initializing it if necessary.
 * This is a synchronous getter that assumes initialization has completed.
 * For async contexts, use `getDeskAsync()` instead.
 */
export function getDesk(): StudioDesk {
  let desk = globalRef[GLOBAL_KEY];
  if (!desk) {
    throw new Error('StudioDesk not initialized. Call getDeskAsync() first.');
  }
  return desk;
}

/** Async version for initialization and serverless contexts. */
export async function getDeskAsync(): Promise<StudioDesk> {
  if (globalRef[GLOBAL_KEY]) {
    return globalRef[GLOBAL_KEY];
  }
  const { createStudioDesk } = await import('@studiodesk/core');
  const desk = await createStudioDesk();
  globalRef[GLOBAL_KEY] = desk;
  return desk;
}

/** The repository driver in use, for the health endpoint. */
export async function driverName(): Promise<string> {
  const desk = await getDeskAsync();
  return desk.ctx.repo.kind;
}

/** Whether Supabase is configured (drives the "connect your database" banner). */
export async function usingMemory(): Promise<boolean> {
  const desk = await getDeskAsync();
  return desk.ctx.repo.kind === 'memory';
}

// Initialize asynchronously at module load
getDeskAsync().catch(console.error);