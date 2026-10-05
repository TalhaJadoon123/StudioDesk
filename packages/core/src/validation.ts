import { AppError } from '@studiodesk/shared';
import { z } from 'zod';

/** Request validation shared by the Fastify API and the Next.js server actions. */

const iso = z.string().min(1);
const nonEmpty = z.string().trim().min(1, 'must not be empty');

export const memberStatusSchema = z.enum(['active', 'paused', 'cancelled']);
export const bookingStatusSchema = z.enum([
  'booked',
  'waitlisted',
  'attended',
  'no-show',
  'cancelled',
]);
export const planTierSchema = z.enum(['free', 'starter', 'business']);
export const currencySchema = z.enum(['usd', 'eur', 'gbp', 'pkr']);

export const createMemberSchema = z.object({
  name: nonEmpty.max(120),
  email: z.string().email().optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  planId: nonEmpty.optional(),
  status: memberStatusSchema.optional(),
  joinedAt: iso.optional(),
  monthlyPriceCents: z.number().int().min(0).optional(),
  currency: currencySchema.optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(2000).optional(),
  kioskPin: z.string().regex(/^\d{4,8}$/).optional(),
  marketingOptIn: z.boolean().optional(),
  studioId: z.string().optional(),
});

export const updateMemberSchema = createMemberSchema.partial().extend({
  pausedUntil: z.string().optional(),
  cancelledAt: z.string().optional(),
});

export const memberQuerySchema = z.object({
  status: memberStatusSchema.optional(),
  search: z.string().trim().optional(),
  planId: z.string().optional(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['name', 'joinedAt', 'churnRisk', 'createdAt']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export const createPlanSchema = z.object({
  name: nonEmpty.max(80),
  priceCents: z.number().int().min(0),
  currency: currencySchema.optional(),
  interval: z.enum(['month', 'year']).optional(),
  classCredits: z.number().int().min(0).nullable().optional(),
  description: z.string().max(500).optional(),
  gatewayProductId: z.string().optional(),
  active: z.boolean().optional(),
  tier: planTierSchema.optional(),
});

export const updatePlanSchema = createPlanSchema.partial();

export const createInstructorSchema = z.object({
  name: nonEmpty.max(120),
  email: z.string().email().optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  bio: z.string().max(2000).optional(),
  specialties: z.array(z.string()).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  active: z.boolean().optional(),
});

export const updateInstructorSchema = createInstructorSchema.partial();

export const createClassSchema = z.object({
  name: nonEmpty.max(120),
  instructorId: nonEmpty,
  startTime: iso,
  endTime: iso.optional(),
  durationMinutes: z.number().int().min(5).max(600).optional(),
  capacity: z.number().int().min(1).max(1000),
  room: z.string().max(80).optional(),
  color: z.string().max(40).optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced', 'all-levels']).optional(),
  description: z.string().max(2000).optional(),
  seriesId: z.string().optional(),
  rrule: z.string().optional(),
  creditCost: z.number().int().min(0).max(10).optional(),
  classType: z.string().max(60).optional(),
  waitlistEnabled: z.boolean().optional(),
  lateCancelHours: z.number().min(0).max(168).optional(),
  status: z.enum(['scheduled', 'cancelled', 'completed']).optional(),
});

export const updateClassSchema = createClassSchema.partial();

export const classQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  instructorId: z.string().optional(),
  status: z.enum(['scheduled', 'cancelled', 'completed']).optional(),
  classType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const createBookingSchema = z.object({
  memberId: nonEmpty,
  classId: nonEmpty,
  source: z.enum(['web', 'mobile', 'kiosk', 'staff', 'api']).optional(),
  note: z.string().max(500).optional(),
  /** Force a booking even when the member is over quota (staff only). */
  override: z.boolean().optional(),
  /** Join the waitlist instead of failing when the class is full. */
  allowWaitlist: z.boolean().optional(),
});

export const cancelBookingSchema = z.object({
  reason: z.string().max(500).optional(),
  waived: z.boolean().optional(),
  waiverReason: z
    .enum(['studio-error', 'instructor-cancel', 'medical', 'manager-override'])
    .optional(),
  /** Staff-initiated cancels are never late. */
  byStaff: z.boolean().optional(),
});

export const checkinSchema = z.object({
  memberId: z.string().optional(),
  bookingId: z.string().optional(),
  classId: z.string().optional(),
  code: z.string().optional(),
  method: z.enum(['qr', 'geo', 'manual', 'kiosk']).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  deviceId: z.string().optional(),
  staffId: z.string().optional(),
});

export const subscriptionSchema = z.object({
  memberId: nonEmpty,
  planId: nonEmpty,
  /** When true the first invoice is charged immediately (no trial). */
  chargeNow: z.boolean().optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  gateway: z.enum(['stripe', 'polar', 'lemonsqueezy', 'manual']).optional(),
});

export const purchaseSchema = z.object({
  memberId: nonEmpty,
  /** Either a catalogue pack name/credits or an explicit amount. */
  packName: z.string().optional(),
  credits: z.number().int().min(1).max(500).optional(),
  priceCents: z.number().int().min(0).optional(),
  currency: currencySchema.optional(),
  idempotencyKey: z.string().optional(),
});

export const dropInSchema = z.object({
  memberId: nonEmpty,
  classId: nonEmpty,
  priceCents: z.number().int().min(0).optional(),
  idempotencyKey: z.string().optional(),
});

export const reportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  days: z.coerce.number().int().min(1).max(730).optional(),
  instructorId: z.string().optional(),
  /** Skip the Groq pass on churn reports (faster, deterministic). */
  enrich: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === 'true')
    .optional(),
});

export const studioSchema = z.object({
  name: nonEmpty.max(120),
  tier: planTierSchema.optional(),
  timezone: z.string().min(1).max(64).optional(),
  currency: currencySchema.optional(),
});

export const geoPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).optional(),
});

/** Parses `data` or throws a 422-shaped AppError. */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  message = 'Invalid request',
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    // A real AppError so the Fastify error handler maps it to 422 rather than
    // treating a client mistake as a 500.
    throw new AppError('validation_failed', message, result.error.flatten());
  }
  return result.data;
}

/** `app.use(CoreError)` in Fastify and `toErrorBody()` everywhere else. */
export function parseOrNull<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
): z.infer<S> | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}