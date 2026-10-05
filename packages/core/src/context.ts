import { EventBus, config } from '@studiodesk/shared';
import {
  MemoryRepository,
  type Repository,
  type Studio,
} from './repository.js';

/**
 * The object every core service receives. Keeping it explicit (instead of
 * importing a singleton) is what makes the whole engine unit-testable with a
 * frozen clock and an in-memory repository.
 */
export interface CoreContext {
  repo: Repository;
  events: EventBus;
  /** Injectable clock - tests pin this so date-sensitive logic is deterministic. */
  now: () => Date;
  /** Optional tenant. `undefined` means "no tenancy" (single-studio demo mode). */
  studioId?: string;
}

export interface CreateContextOptions {
  repo?: Repository;
  events?: EventBus;
  now?: () => Date;
  studioId?: string;
}

export function createContext(options: CreateContextOptions = {}): CoreContext {
  return {
    repo: options.repo ?? new MemoryRepository(),
    events: options.events ?? new EventBus(),
    now: options.now ?? (() => new Date()),
    studioId: options.studioId,
  };
}

/** Default studio used when nothing has been provisioned yet (demo mode). */
export const DEFAULT_STUDIO: Studio = {
  id: 'std_demo',
  name: 'StudioDesk Demo Studio',
  tier: 'business',
  timezone: 'Europe/London',
  currency: 'usd',
  settings: {
    lateCancelHours: 4,
    noShowFeeCents: 500,
    lateCancelFeeCents: 300,
    waitlistNotify: true,
    checkinOpensMinutesBefore: 30,
    checkinClosesMinutesAfter: 15,
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** Fee + policy defaults, overridable per studio via `studios.settings`. */
export const DEFAULT_SETTINGS = {
  lateCancelHours: 4,
  lateCancelFeeCents: 300,
  noShowFeeCents: 500,
  waitlistEnabled: true,
  checkinOpensMinutesBefore: 30,
  checkinClosesMinutesAfter: 15,
  packExpiryDays: 90,
  dunningRetryAfterDays: [1, 3, 5],
  dunningPauseAfterDays: 7,
  dunningCancelAfterDays: 21,
  autoPauseOnFailedPayment: true,
} as const;

export type StudioSettings = Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>;

export async function getStudioSettings(ctx: CoreContext): Promise<StudioSettings> {
  if (!ctx.studioId) return { ...DEFAULT_SETTINGS };
  const studio = await ctx.repo.table('studios').findById(ctx.studioId);
  const settings = (studio?.settings ?? {}) as StudioSettings;
  return { ...DEFAULT_SETTINGS, ...settings };
}

/**
 * Picks the repository driver: Supabase when configured, otherwise in-memory.
 * This is the single place the app decides where data lives.
 */
export async function createRepository(): Promise<{
  repo: Repository;
  driver: 'supabase' | 'memory';
  warning?: string;
}> {
  if (config.hasHostedBackend()) {
    try {
      const { createSupabaseRepository } = await import('./supabase.js');
      const supabase = await createSupabaseRepository();
      if (supabase) return { repo: supabase, driver: 'supabase' };
    } catch (error) {
      return {
        repo: new MemoryRepository(),
        driver: 'memory',
        warning: `Supabase configured but unreachable, falling back to memory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  return { repo: new MemoryRepository(), driver: 'memory' };
}