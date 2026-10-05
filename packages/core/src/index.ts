import { EventBus } from '@studiodesk/shared';
import { createContext, type CoreContext, type CreateContextOptions } from './context.js';
import * as studio from './studio.js';
import * as members from './members.js';
import * as plans from './plans.js';
import * as classes from './classes.js';
import * as bookings from './bookings.js';
import * as attendance from './attendance.js';
import * as churn from './churn.js';
import * as notifications from './notifications.js';
import * as reports from './reports.js';
import { connectNotifications } from './notifications.js';

export * from './repository.js';
export type { TableName, Row, Table } from './repository.js';
import type { TableName } from './repository.js';
export * from './context.js';
export * from './validation.js';
export * from './groq.js';
export { MemoryRepository, MemoryTable, matchesFilter } from './repository.js';
export { SupabaseRepository, createSupabaseRepository, SUPABASE_SCHEMA_SQL } from './supabase.js';
export * from './studio.js';
export * from './members.js';
export * from './plans.js';
export * from './classes.js';
export * from './bookings.js';
export * from './attendance.js';
export * from './churn.js';
export * from './notifications.js';
export * from './reports.js';
export * from './seed.js';

/** Which driver `createRepository()` selected. */
export const memoryDriver = 'memory' as const;

/**
 * The physical shape StudioDesk uses in Supabase. Exported so the schema,
 * the tests and the docs cannot drift apart.
 */
export const supabaseFilterSpec = {
  table: 'records',
  primaryKey: ['table_name', 'id'],
  payloadColumn: 'data',
  tables: [
    'studios',
    'members',
    'plans',
    'instructors',
    'classes',
    'bookings',
    'attendance',
    'memberships',
    'invoices',
    'charges',
    'packs',
    'dropIns',
    'fees',
    'notifications',
    'dunningEvents',
    'devices',
  ] as TableName[],
} as const;

export interface CreateStudioDeskOptions extends CreateContextOptions {
  /** Wire domain events to member notifications (default true). */
  withNotifications?: boolean;
}

/**
 * The one object the API, web and mobile apps hold.
 *
 * ```ts
 * const desk = await createStudioDesk();
 * await desk.members.create({ name: 'Ada' });
 * ```
 */
export interface StudioDesk {
  /** Shorthand for `desk.ctx.repo`. */
  readonly repo: CoreContext['repo'];
  ctx: CoreContext;
  events: EventBus;
  studio: typeof studio;
  members: typeof members;
  plans: typeof plans;
  classes: typeof classes;
  bookings: typeof bookings;
  attendance: typeof attendance;
  churn: typeof churn;
  notifications: typeof notifications;
  reports: typeof reports;
  dispose(): void;
}

export async function createStudioDesk(options: CreateStudioDeskOptions = {}): Promise<StudioDesk> {
  const repo = options.repo ?? (await (async () => {
    const { createRepository } = await import('./context.js');
    const { repo } = await createRepository();
    return repo;
  })());

  const ctx = createContext({ ...options, repo });
  const handle = options.withNotifications === false ? null : connectNotifications(ctx);

  return {
    repo: ctx.repo,
    ctx,
    events: ctx.events,
    studio,
    members,
    plans,
    classes,
    bookings,
    attendance,
    churn,
    notifications,
    reports,
    dispose: () => {
      handle?.dispose();
      ctx.events.clear();
      return void repo.close();
    },
  };
}

/** Convenience for tests: in-memory desk with a pinned clock. */
export function createTestDesk(now: Date | (() => Date) = new Date('2026-01-15T09:00:00.000Z')): StudioDesk {
  const clock = typeof now === 'function' ? now : () => now;
  const ctx = createContext({ now: clock });
  const handle = connectNotifications(ctx);
  return {
    repo: ctx.repo,
    ctx,
    events: ctx.events,
    studio,
    members,
    plans,
    classes,
    bookings,
    attendance,
    churn,
    notifications,
    reports,
    dispose: () => {
      handle.dispose();
      ctx.events.clear();
    },
  };
}

export { createContext };