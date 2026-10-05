import {
  addMinutes,
  conflict,
  notFound,
  newClassId,
  newInstructorId,
  sortBy,
  type Class,
  type ClassOccurrence,
  type Instructor,
  type Paginated,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { assertClassTypeAllowed, getPlanLimits, getStudio } from './studio.js';
import type { Filter } from './repository.js';

export function classesRepo(ctx: CoreContext) {
  return ctx.repo.table('classes');
}
export function instructorsRepo(ctx: CoreContext) {
  return ctx.repo.table('instructors');
}

export const DEFAULT_DURATION_MINUTES = 60;

/* -------------------------------------------------------------------------- */
/* Instructors                                                                */
/* -------------------------------------------------------------------------- */

export async function createInstructor(
  ctx: CoreContext,
  input: {
    name: string;
    email?: string;
    phone?: string;
    bio?: string;
    specialties?: string[];
    color?: string;
    active?: boolean;
  },
): Promise<Instructor> {
  const studio = await getStudio(ctx);
  const limits = await getPlanLimits(ctx);
  if (limits.maxInstructors !== null) {
    const count = await instructorsRepo(ctx).count();
    if (count + 1 > limits.maxInstructors) {
      const err = new Error(`Your plan allows ${limits.maxInstructors} instructors`);
      (err as Error & { code: string; statusCode: number }).code = 'limit_reached';
      (err as Error & { statusCode: number }).statusCode = 402;
      throw err;
    }
  }
  const at = ctx.now().toISOString();
  return instructorsRepo(ctx).insert({
    id: newInstructorId(),
    studioId: studio.id,
    name: input.name,
    email: input.email?.toLowerCase(),
    phone: input.phone,
    bio: input.bio,
    specialties: input.specialties ?? [],
    color: input.color ?? randomInstructorColor(),
    active: input.active ?? true,
    createdAt: at,
    updatedAt: at,
  });
}

const INSTRUCTOR_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#0ea5e9',
  '#64748b',
];

function randomInstructorColor(): string {
  return INSTRUCTOR_COLORS[Math.floor(Math.random() * INSTRUCTOR_COLORS.length)]!;
}

export async function updateInstructor(
  ctx: CoreContext,
  id: string,
  patch: Partial<Instructor>,
): Promise<Instructor> {
  await requireInstructor(ctx, id);
  return instructorsRepo(ctx).update(id, { ...patch, updatedAt: ctx.now().toISOString() });
}

export async function getInstructor(ctx: CoreContext, id: string): Promise<Instructor | null> {
  return instructorsRepo(ctx).findById(id);
}

export async function requireInstructor(ctx: CoreContext, id: string): Promise<Instructor> {
  const instructor = await getInstructor(ctx, id);
  if (!instructor) throw notFound('Instructor', id);
  return instructor;
}

export async function listInstructors(ctx: CoreContext, options: { activeOnly?: boolean } = {}): Promise<Instructor[]> {
  const rows = await instructorsRepo(ctx).list();
  const studio = await getStudio(ctx);
  const scoped = rows.filter((row) => !row.studioId || row.studioId === studio.id);
  return sortBy(
    options.activeOnly ? scoped.filter((row) => row.active) : scoped,
    (row) => row.name,
    'asc',
  );
}

/** Class + booking counts used on the instructor roster page. */
export async function instructorStats(ctx: CoreContext) {
  const [instructors, classes, bookings, attendance] = await Promise.all([
    listInstructors(ctx),
    classesRepo(ctx).list(),
    ctx.repo.table('bookings').list(),
    ctx.repo.table('attendance').list(),
  ]);
  const classIds = new Map(classes.map((c) => [c.id, c]));
  const attendedClassIds = new Set(attendance.map((a) => a.classId));
  return instructors.map((instructor) => {
    const own = classes.filter((c) => c.instructorId === instructor.id);
    const ownIds = new Set(own.map((c) => c.id));
    const ownBookings = bookings.filter((b) => ownIds.has(b.classId));
    return {
      instructor,
      classesCount: own.length,
      bookingsCount: ownBookings.filter((b) => b.status === 'attended').length,
      attendedCount: attendance.filter((a) => ownIds.has(a.classId)).length,
      noShowCount: ownBookings.filter((b) => b.status === 'no-show').length,
      fillRate: own.length
        ? Number(
            (
              ownBookings.filter((b) => b.status === 'booked' || b.status === 'attended').length /
              own.reduce((acc, c) => acc + (c.capacity || 1), 0)
            ).toFixed(3),
          )
        : 0,
      attendedShare: ownIds.size
        ? Number(([...attendedClassIds].filter((id) => ownIds.has(id)).length / ownIds.size).toFixed(3))
        : 0,
      upcoming: own.filter((c) => Date.parse(c.startTime) > ctx.now().getTime()).length,
      lastClassAt: own.map((c) => c.startTime).sort().at(-1) ?? null,
      klassCount: classIds.size,
    };
  });
}

export async function deleteInstructor(ctx: CoreContext, id: string): Promise<boolean> {
  await requireInstructor(ctx, id);
  const upcoming = await classesRepo(ctx).list({ filter: { instructorId: id }, limit: 1000 });
  const future = upcoming.filter((c) => Date.parse(c.startTime) > ctx.now().getTime());
  if (future.length) {
    throw conflict(`Reassign ${future.length} upcoming class(es) before deleting this instructor`);
  }
  return instructorsRepo(ctx).remove(id);
}

/* -------------------------------------------------------------------------- */
/* Classes                                                                    */
/* -------------------------------------------------------------------------- */

export async function createClass(
  ctx: CoreContext,
  input: {
    name: string;
    instructorId: string;
    startTime: string;
    endTime?: string;
    durationMinutes?: number;
    capacity: number;
    room?: string;
    color?: string;
    level?: Class['level'];
    description?: string;
    seriesId?: string;
    rrule?: string;
    creditCost?: number;
    classType?: string;
    waitlistEnabled?: boolean;
    lateCancelHours?: number;
    status?: Class['status'];
  },
): Promise<Class> {
  const [studio, instructor] = await Promise.all([getStudio(ctx), requireInstructor(ctx, input.instructorId)]);
  await assertClassTypeAllowed(ctx, input.classType);
  const at = ctx.now().toISOString();
  const duration = input.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const klass: Class = {
    id: newClassId(),
    studioId: studio.id,
    name: input.name,
    instructorId: instructor.id,
    startTime: new Date(input.startTime).toISOString(),
    endTime: input.endTime
      ? new Date(input.endTime).toISOString()
      : addMinutes(input.startTime, duration).toISOString(),
    capacity: input.capacity,
    durationMinutes: duration,
    room: input.room,
    color: input.color ?? instructor.color,
    level: input.level ?? 'all-levels',
    description: input.description,
    status: input.status ?? 'scheduled',
    seriesId: input.seriesId,
    rrule: input.rrule,
    creditCost: input.creditCost ?? 1,
    classType: input.classType ?? input.name,
    waitlistEnabled: input.waitlistEnabled ?? true,
    lateCancelHours: input.lateCancelHours ?? 4,
    createdAt: at,
    updatedAt: at,
  };
  const created = await classesRepo(ctx).insert(klass);
  await ctx.events.emit('class.created', { classId: created.id, name: created.name });
  return created;
}

export async function updateClass(ctx: CoreContext, id: string, patch: Partial<Class>): Promise<Class> {
  const existing = await requireClass(ctx, id);
  if (patch.instructorId) await requireInstructor(ctx, patch.instructorId);
  const next: Partial<Class> = { ...patch, updatedAt: ctx.now().toISOString() };
  if (patch.startTime && !patch.endTime && patch.durationMinutes !== undefined) {
    next.endTime = addMinutes(patch.startTime, patch.durationMinutes).toISOString();
  }
  if (patch.classType) await assertClassTypeAllowed(ctx, patch.classType);

  // Cancelling a full class cascades to its bookings (see booking.ts).
  if (patch.status === 'cancelled' && existing.status !== 'cancelled') {
    await cancelClass(ctx, id, 'Class cancelled by studio');
  }
  const updated = await classesRepo(ctx).update(id, next);
  await ctx.events.emit('class.updated', { classId: id });
  return updated;
}

export async function getClass(ctx: CoreContext, id: string): Promise<Class | null> {
  return classesRepo(ctx).findById(id);
}

export async function requireClass(ctx: CoreContext, id: string): Promise<Class> {
  const klass = await getClass(ctx, id);
  if (!klass) throw notFound('Class', id);
  return klass;
}

export async function deleteClass(ctx: CoreContext, id: string): Promise<boolean> {
  await requireClass(ctx, id);
  const bookings = await ctx.repo.table('bookings').count({ filter: { classId: id } });
  if (bookings > 0) {
    throw conflict(`Class has ${bookings} booking(s). Cancel it instead of deleting.`);
  }
  return classesRepo(ctx).remove(id);
}

export interface ListClassesQuery {
  from?: string;
  to?: string;
  instructorId?: string;
  status?: Class['status'];
  classType?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

export function classFilter(query: ListClassesQuery): Filter {
  const filter: Filter = {};
  if (query.instructorId) filter.instructorId = query.instructorId;
  if (query.status) filter.status = query.status;
  if (query.classType) filter.classType = query.classType;
  if (query.name) filter.name = { $like: query.name };
  if (query.from || query.to) {
    filter.startTime = {
      ...(query.from ? { $gte: new Date(query.from).toISOString() } : {}),
      ...(query.to ? { $lte: new Date(query.to).toISOString() } : {}),
    } as never;
  }
  return filter;
}

export async function listClasses(ctx: CoreContext, query: ListClassesQuery = {}): Promise<Class[]> {
  const rows = await classesRepo(ctx).list({
    filter: classFilter(query),
    order: { field: 'startTime', dir: 'asc' },
  });
  const offset = query.offset ?? 0;
  const limit = query.limit ?? rows.length;
  return rows.slice(offset, offset + limit);
}

export async function countClasses(ctx: CoreContext, query: ListClassesQuery = {}): Promise<number> {
  return classesRepo(ctx).count({ filter: classFilter(query) });
}

export async function listClassesPaginated(
  ctx: CoreContext,
  query: ListClassesQuery = {},
): Promise<Paginated<Class>> {
  const [items, total] = await Promise.all([
    listClasses(ctx, { ...query, offset: query.offset ?? 0, limit: query.limit ?? 50 }),
    countClasses(ctx, query),
  ]);
  const pageSize = query.limit ?? 50;
  const offset = query.offset ?? 0;
  return {
    items,
    total,
    page: Math.floor(offset / pageSize) + 1,
    pageSize,
    hasMore: offset + items.length < total,
  };
}

export async function classesInRange(ctx: CoreContext, fromIso: string, toIso: string): Promise<Class[]> {
  return listClasses(ctx, { from: fromIso, to: toIso });
}

export async function todayClasses(ctx: CoreContext): Promise<Class[]> {
  const start = new Date(ctx.now());
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000 - 1);
  return classesInRange(ctx, start.toISOString(), end.toISOString());
}

export async function upcomingClasses(ctx: CoreContext, limit = 20): Promise<Class[]> {
  return classesRepo(ctx).list({
    filter: { startTime: { $gte: ctx.now().toISOString() }, status: 'scheduled' },
    order: { field: 'startTime', dir: 'asc' },
    limit,
  });
}

export async function distinctClassTypes(ctx: CoreContext): Promise<string[]> {
  const rows = await classesRepo(ctx).list({ limit: 1000 });
  return [...new Set(rows.map((row) => (row.classType ?? row.name).trim() || row.name))].sort();
}

/**
 * Cancels a class and cancels every live booking, waiving any late-cancel fee
 * because the studio (not the member) caused it.
 */
export async function cancelClass(ctx: CoreContext, id: string, reason: string): Promise<{ klass: Class; cancelledBookings: number }> {
  const klass = await requireClass(ctx, id);
  const bookings = await ctx.repo.table('bookings').list({ filter: { classId: id } });
  let cancelled = 0;
  for (const booking of bookings) {
    if (booking.status === 'cancelled' || booking.status === 'attended') continue;
    await ctx.repo.table('bookings').update(booking.id, {
      status: 'cancelled',
      cancelledAt: ctx.now().toISOString(),
      updatedAt: ctx.now().toISOString(),
      note: reason,
    });
    cancelled += 1;
  }
  const updated = await classesRepo(ctx).update(id, {
    status: 'cancelled',
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.events.emit('class.cancelled', { classId: id, name: klass.name, affected: cancelled });
  return { klass: updated, cancelledBookings: cancelled };
}

/** Marks a past class as completed. Returns the class plus attendance math. */
export async function completeClass(ctx: CoreContext, id: string): Promise<Class> {
  const klass = await requireClass(ctx, id);
  return classesRepo(ctx).update(id, { status: 'completed', updatedAt: ctx.now().toISOString(), ...(klass ? {} : {}) });
}

/* -------------------------------------------------------------------------- */
/* Occurrences (a series renders as occurrences; see booking/recurring.ts)     */
/* -------------------------------------------------------------------------- */

export interface ClassView extends Class {
  booked: number;
  waitlisted: number;
  attended: number;
  spotsLeft: number;
  isFull: boolean;
  isPast: boolean;
  instructorName?: string;
}

/** Joins classes with live booking counts in one pass. */
export async function listClassesWithCounts(
  ctx: CoreContext,
  query: ListClassesQuery = {},
): Promise<ClassView[]> {
  const classes = await listClasses(ctx, query);
  if (!classes.length) return [];
  const [bookings, instructors] = await Promise.all([
    ctx.repo.table('bookings').list({ limit: 100_000 }),
    instructorsRepo(ctx).list(),
  ]);
  const instructorName = new Map(instructors.map((i) => [i.id, i.name] as const));
  const nowMs = ctx.now().getTime();

  const counts = new Map<string, { booked: number; waitlisted: number; attended: number }>();
  for (const booking of bookings) {
    const bucket = counts.get(booking.classId) ?? { booked: 0, waitlisted: 0, attended: 0 };
    if (booking.status === 'booked') bucket.booked += 1;
    else if (booking.status === 'waitlisted') bucket.waitlisted += 1;
    else if (booking.status === 'attended') bucket.attended += 1;
    counts.set(booking.classId, bucket);
  }

  return classes.map((klass) => {
    const count = counts.get(klass.id) ?? { booked: 0, waitlisted: 0, attended: 0 };
    const liveBooked = count.booked + count.attended;
    return {
      ...klass,
      ...count,
      booked: liveBooked,
      spotsLeft: Math.max(0, klass.capacity - liveBooked),
      isFull: liveBooked >= klass.capacity,
      isPast: Date.parse(klass.startTime) < nowMs,
      instructorName: instructorName.get(klass.instructorId),
    };
  });
}

export function toOccurrence(klass: Class, occurrenceId: string): ClassOccurrence {
  return { ...klass, occurrenceId, seriesId: klass.seriesId };
}