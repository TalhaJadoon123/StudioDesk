import {
  AppError,
  addHours,
  conflict,
  forbidden,
  hoursUntil,
  newBookingId,
  notFound,
  sortBy,
  type Booking,
  type BookingResult,
  type BookingWithContext,
  type Class,
  type ClassPack,
  type Member,
} from '@studiodesk/shared';
import type { CoreContext } from './context.js';
import { getStudioSettings, hasFeature } from './studio.js';
import { assertBookable } from './members.js';
import type { Filter } from './repository.js';

export function bookingsRepo(ctx: CoreContext) {
  return ctx.repo.table('bookings');
}

export const MAX_WAITLIST = 25;

export interface CreateBookingInput {
  memberId: string;
  classId: string;
  source?: Booking['source'];
  note?: string;
  /** Skip the credit requirement and any plan gating. */
  override?: boolean;
  allowWaitlist?: boolean;
  /** Staff bookings are never "late" when later cancelled. */
  byStaff?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Booking                                                                    */
/* -------------------------------------------------------------------------- */

export async function createBooking(
  ctx: CoreContext,
  input: CreateBookingInput,
): Promise<BookingResult> {
  const [member, klass] = await Promise.all([
    ctx.repo.table('members').findById(input.memberId),
    ctx.repo.table('classes').findById(input.classId),
  ]);
  if (!member) throw notFound('Member', input.memberId);
  if (!klass) throw notFound('Class', input.classId);
  if (klass.status === 'cancelled') throw conflict(`${klass.name} has been cancelled`);

  if (!input.override) assertBookable(member, klass, ctx.now());

  const existing = await bookingsRepo(ctx).findOne({
    filter: {
      memberId: input.memberId,
      classId: input.classId,
      $or: [{ status: 'booked' }, { status: 'waitlisted' }],
    },
  });
  if (existing) {
    throw conflict(
      existing.status === 'waitlisted'
        ? `${member.name} is already on the waitlist (position ${existing.waitlistPosition})`
        : `${member.name} is already booked into ${klass.name}`,
      { bookingId: existing.id, status: existing.status },
    );
  }

  const live = await liveBookings(ctx, input.classId);
  const confirmed = live.filter((b) => b.status === 'booked' || b.status === 'attended').length;
  const waitlistEnabled = klass.waitlistEnabled ?? (await getStudioSettings(ctx)).waitlistEnabled ?? true;
  const tierAllows = await hasFeature(ctx, 'waitlist');

  const at = ctx.now().toISOString();

  // Full class -> waitlist or hard failure.
  if (confirmed >= klass.capacity) {
    const mayWaitlist = (input.allowWaitlist ?? false) && waitlistEnabled && tierAllows && !input.override;
    if (!mayWaitlist) {
      if (confirmed >= klass.capacity && input.allowWaitlist && !tierAllows) {
        throw forbidden('Waitlists are a Starter feature. Upgrade to add one.');
      }
      throw new AppError('class_full', `${klass.name} is full (${klass.capacity} spots)`, {
        classId: klass.id,
        capacity: klass.capacity,
        waitlistAvailable: waitlistEnabled && tierAllows,
      });
    }
    const position = await nextWaitlistPosition(ctx, input.classId);
    if (position > MAX_WAITLIST) {
      throw conflict(`The waitlist for ${klass.name} is full (${MAX_WAITLIST} people)`);
    }
    const booking = await bookingsRepo(ctx).insert({
      id: newBookingId(),
      memberId: input.memberId,
      classId: input.classId,
      status: 'waitlisted',
      waitlistPosition: position,
      waitlistJoinedAt: at,
      bookedAt: at,
      creditsCharged: 0,
      source: input.source ?? 'web',
      note: input.note,
      createdAt: at,
      updatedAt: at,
    });
    await ctx.events.emit('booking.waitlisted', {
      bookingId: booking.id,
      memberId: input.memberId,
      classId: input.classId,
      position,
    });
    return { booking, waitlistPosition: position, chargedCredits: 0, promoted: [] };
  }

  // Spot available -> confirm and charge credits.
  const chargedCredits = input.override ? 0 : await consumeCredit(ctx, member, klass);
  const booking = await bookingsRepo(ctx).insert({
    id: newBookingId(),
    memberId: input.memberId,
    classId: input.classId,
    status: 'booked',
    bookedAt: at,
    creditsCharged: chargedCredits,
    source: input.source ?? 'web',
    note: input.note,
    createdAt: at,
    updatedAt: at,
  });
  await ctx.events.emit('booking.created', {
    bookingId: booking.id,
    memberId: input.memberId,
    classId: input.classId,
  });
  return { booking, chargedCredits, promoted: [] };
}

/** Book several members at once (staff action from the roster). */
export async function createBookings(
  ctx: CoreContext,
  inputs: CreateBookingInput[],
): Promise<{ booked: Booking[]; waitlisted: Booking[]; failed: Array<{ input: CreateBookingInput; error: string }> }> {
  const booked: Booking[] = [];
  const waitlisted: Booking[] = [];
  const failed: Array<{ input: CreateBookingInput; error: string }> = [];
  for (const input of inputs) {
    try {
      const result = await createBooking(ctx, input);
      if (result.booking.status === 'waitlisted') waitlisted.push(result.booking);
      else booked.push(result.booking);
    } catch (error) {
      failed.push({ input, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { booked, waitlisted, failed };
}

/* -------------------------------------------------------------------------- */
/* Credits                                                                    */
/* -------------------------------------------------------------------------- */

/** Total usable credits across a member's unexpired packs. */
export async function creditBalance(ctx: CoreContext, memberId: string): Promise<number> {
  const packs = await usablePacks(ctx, memberId);
  return packs.reduce((acc, pack) => acc + pack.creditsRemaining, 0);
}

async function usablePacks(ctx: CoreContext, memberId: string): Promise<ClassPack[]> {
  const packs = await ctx.repo.table('packs').list({ filter: { memberId, status: 'active' } });
  const today = ctx.now().toISOString();
  return packs.filter((pack) => pack.creditsRemaining > 0 && (!pack.expiresAt || pack.expiresAt > today));
}

/**
 * Charges a booking against the member's packs. Unlimited plans are free.
 * Members with no credits still book (pay at the door) but we flag it.
 */
async function consumeCredit(ctx: CoreContext, member: Member, klass: Class): Promise<number> {
  const cost = klass.creditCost ?? 1;
  if (cost <= 0) return 0;

  const plan = member.planId ? await ctx.repo.table('plans').findById(member.planId) : null;
  if (plan && plan.classCredits === null && plan.name.toLowerCase().includes('unlimited')) return 0;

  const packs = await usablePacks(ctx, member.id);
  let remaining = cost;
  let charged = 0;
  for (const pack of packs) {
    if (remaining <= 0) break;
    const take = Math.min(pack.creditsRemaining, remaining);
    const creditsRemaining = pack.creditsRemaining - take;
    await ctx.repo.table('packs').update(pack.id, {
      creditsRemaining,
      status: creditsRemaining <= 0 ? 'depleted' : 'active',
      updatedAt: ctx.now().toISOString(),
    });
    remaining -= take;
    charged += take;
    if (creditsRemaining <= 0) {
      await ctx.events.emit('pack.low', { packId: pack.id, memberId: member.id, creditsRemaining: 0 });
    }
  }
  return charged;
}

/** Returns a cancelled booking's credit to the pack it came from. */
async function refundCredit(ctx: CoreContext, booking: Booking): Promise<number> {
  const charged = booking.creditsCharged ?? 0;
  if (charged <= 0) return 0;
  const packs = await ctx.repo.table('packs').list({ filter: { memberId: booking.memberId } });
  // Refund to the pack with the fewest credits so expiry drains predictably.
  const target = sortBy(
    packs.filter((pack) => pack.status === 'depleted' || pack.status === 'active'),
    (pack) => pack.creditsRemaining,
    'asc',
  )[0];
  if (!target) return 0;
  await ctx.repo.table('packs').update(target.id, {
    creditsRemaining: target.creditsRemaining + charged,
    status: 'active',
    updatedAt: ctx.now().toISOString(),
  });
  return charged;
}

/* -------------------------------------------------------------------------- */
/* Waitlist                                                                   */
/* -------------------------------------------------------------------------- */

export async function nextWaitlistPosition(ctx: CoreContext, classId: string): Promise<number> {
  const waiting = await ctx.repo.table('bookings').list({ filter: { classId, status: 'waitlisted' } });
  return waiting.reduce((max, b) => Math.max(max, b.waitlistPosition ?? 0), 0) + 1;
}

export async function waitlist(ctx: CoreContext, classId: string): Promise<BookingWithContext[]> {
  const [bookings, members, classes] = await Promise.all([
    bookingsRepo(ctx).list({ filter: { classId, status: 'waitlisted' } }),
    ctx.repo.table('members').list(),
    ctx.repo.table('classes').list(),
  ]);
  const memberName = new Map(members.map((m) => [m.id, m.name] as const));
  const classById = new Map(classes.map((c) => [c.id, c] as const));
  return sortBy(
    bookings.map((booking) => ({
      ...booking,
      memberName: memberName.get(booking.memberId),
      className: classById.get(booking.classId)?.name,
      startTime: classById.get(booking.classId)?.startTime,
    })),
    (b) => b.waitlistPosition ?? 0,
    'asc',
  );
}

/**
 * Promotes waitlisted members into freed spots, in order, until the class is
 * full or the waitlist is empty. Called automatically on every cancellation.
 * Returns everyone promoted so the caller can notify them.
 */
export async function promoteWaitlist(ctx: CoreContext, classId: string, slots?: number): Promise<Booking[]> {
  const klass = await ctx.repo.table('classes').findById(classId);
  if (!klass) throw notFound('Class', classId);
  if (klass.status === 'cancelled') return [];

  const live = await liveBookings(ctx, classId);
  const confirmed = live.filter((b) => b.status === 'booked' || b.status === 'attended').length;
  let free = klass.capacity - confirmed;
  if (slots !== undefined) free = Math.min(free, Math.max(0, slots));
  if (free <= 0) return [];

  const queue = sortBy(
    live.filter((b) => b.status === 'waitlisted'),
    (b) => b.waitlistJoinedAt ?? b.createdAt ?? '',
    'asc',
  );

  const promoted: Booking[] = [];
  for (const candidate of queue) {
    if (free <= 0) break;
    const member = await ctx.repo.table('members').findById(candidate.memberId);
    // Skip members who left or paused - do not burn a spot on them.
    if (!member || member.status !== 'active') {
      await bookingsRepo(ctx).update(candidate.id, {
        status: 'cancelled',
        cancelledAt: ctx.now().toISOString(),
        waitlistPosition: undefined,
        note: 'Removed from waitlist: member is no longer active',
        updatedAt: ctx.now().toISOString(),
      });
      continue;
    }
    const chargedCredits = await consumeCredit(ctx, member, klass);
    const at = ctx.now().toISOString();
    const updated = await bookingsRepo(ctx).update(candidate.id, {
      status: 'booked',
      waitlistPosition: undefined,
      promotedAt: at,
      updatedAt: at,
      creditsCharged: (candidate.creditsCharged ?? 0) + chargedCredits,
    });
    promoted.push(updated);
    await ctx.events.emit('booking.promoted', {
      bookingId: updated.id,
      memberId: updated.memberId,
      classId,
    });
    free -= 1;
  }

  await resequenceWaitlist(ctx, classId);
  return promoted;
}

/** Keeps waitlist positions 1..n with no gaps after cancellations. */
export async function resequenceWaitlist(ctx: CoreContext, classId: string): Promise<number> {
  const queue = sortBy(
    (await bookingsRepo(ctx).list({ filter: { classId, status: 'waitlisted' } })),
    (b) => b.waitlistPosition ?? b.waitlistJoinedAt ?? b.createdAt ?? '',
    'asc',
  );
  let changed = 0;
  let position = 1;
  for (const booking of queue) {
    if (booking.waitlistPosition !== position) {
      await bookingsRepo(ctx).update(booking.id, { waitlistPosition: position });
      changed += 1;
    }
    position += 1;
  }
  return changed;
}

/** Drops a member off the waitlist without consuming a spot. */
export async function leaveWaitlist(ctx: CoreContext, bookingId: string): Promise<Booking> {
  const booking = await requireBooking(ctx, bookingId);
  if (booking.status !== 'waitlisted') throw conflict('That booking is not on a waitlist');
  const updated = await bookingsRepo(ctx).update(bookingId, {
    status: 'cancelled',
    cancelledAt: ctx.now().toISOString(),
    waitlistPosition: undefined,
    updatedAt: ctx.now().toISOString(),
  });
  await resequenceWaitlist(ctx, booking.classId);
  return updated;
}

/* -------------------------------------------------------------------------- */
/* Cancellation                                                               */
/* -------------------------------------------------------------------------- */

export interface CancelBookingInput {
  reason?: string;
  /** Skip the late-cancel fee. */
  waived?: boolean;
  waiverReason?: 'studio-error' | 'instructor-cancel' | 'medical' | 'manager-override';
  byStaff?: boolean;
  /** Set when the class itself was cancelled by the studio. */
  classCancelled?: boolean;
}

export interface CancelBookingResult {
  booking: Booking;
  late: boolean;
  refundCredits: number;
  promoted: Booking[];
  /** Populated by the billing package when a fee is assessed. */
  feeId?: string;
}

export async function cancelBooking(
  ctx: CoreContext,
  bookingId: string,
  input: CancelBookingInput = {},
): Promise<CancelBookingResult> {
  const booking = await requireBooking(ctx, bookingId);
  if (booking.status === 'cancelled') throw new AppError('already_cancelled', 'Booking is already cancelled');
  if (booking.status === 'attended') throw conflict('You cannot cancel a class you already attended');

  const klass = await ctx.repo.table('classes').findById(booking.classId);
  const settings = await getStudioSettings(ctx);
  const lateCancelHours = klass?.lateCancelHours ?? settings.lateCancelHours ?? 4;

  const wasWaitlisted = booking.status === 'waitlisted';
  const hours = klass ? hoursUntil(klass.startTime, ctx.now()) : Number.POSITIVE_INFINITY;
  const late =
    !wasWaitlisted &&
    !input.byStaff &&
    !input.classCancelled &&
    hours < lateCancelHours &&
    klass?.status === 'scheduled';

  const at = ctx.now().toISOString();
  const updated = await bookingsRepo(ctx).update(bookingId, {
    status: 'cancelled',
    cancelledAt: at,
    waitlistPosition: undefined,
    updatedAt: at,
    note: input.reason ? `${booking.note ? `${booking.note}\n` : ''}${input.reason}` : booking.note,
  });

  // A late cancellation costs the credit that was consumed.
  const refundCredits = late ? 0 : await refundCredit(ctx, booking);

  await ctx.events.emit('booking.cancelled', {
    bookingId,
    memberId: booking.memberId,
    classId: booking.classId,
    late,
  });

  // Freeing a confirmed spot pulls the next person off the waitlist. Leaving a
  // waitlist only needs the queue renumbered.
  let promoted: Booking[] = [];
  if (wasWaitlisted) {
    await resequenceWaitlist(ctx, booking.classId);
  } else {
    promoted = await promoteWaitlist(ctx, booking.classId);
  }

  return { booking: updated, late, refundCredits, promoted };
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/** Called by check-in. */
export async function markAttended(ctx: CoreContext, bookingId: string): Promise<Booking> {
  const booking = await requireBooking(ctx, bookingId);
  if (booking.status === 'attended') return booking;
  if (booking.status === 'cancelled') throw conflict('Cancelled bookings cannot be marked attended');
  return bookingsRepo(ctx).update(bookingId, { status: 'attended', updatedAt: ctx.now().toISOString() });
}

export async function markNoShow(ctx: CoreContext, bookingId: string): Promise<Booking> {
  const booking = await requireBooking(ctx, bookingId);
  return bookingsRepo(ctx).update(bookingId, { status: 'no-show', updatedAt: ctx.now().toISOString() });
}

/**
 * Closes out a class: anything still `booked` becomes a no-show and the class
 * is completed. Billing listens for `class.completed` to charge no-show fees.
 */
export async function finalizeClass(
  ctx: CoreContext,
  classId: string,
): Promise<{ classId: string; noShows: number; attended: number }> {
  const klass = await ctx.repo.table('classes').findById(classId);
  if (!klass) throw notFound('Class', classId);
  const live = await liveBookings(ctx, classId);
  let noShows = 0;
  let attended = 0;
  for (const booking of live) {
    if (booking.status === 'booked') {
      await bookingsRepo(ctx).update(booking.id, { status: 'no-show', updatedAt: ctx.now().toISOString() });
      noShows += 1;
    } else if (booking.status === 'attended') {
      attended += 1;
    }
  }
  await ctx.repo.table('classes').update(classId, {
    status: 'completed',
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.events.emit('class.completed', { classId, name: klass.name, noShows, attended });
  return { classId, noShows, attended };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export async function getBooking(ctx: CoreContext, id: string): Promise<Booking | null> {
  return bookingsRepo(ctx).findById(id);
}

export async function requireBooking(ctx: CoreContext, id: string): Promise<Booking> {
  const booking = await getBooking(ctx, id);
  if (!booking) throw notFound('Booking', id);
  return booking;
}

export async function deleteBooking(ctx: CoreContext, id: string): Promise<boolean> {
  return bookingsRepo(ctx).remove(id);
}

async function liveBookings(ctx: CoreContext, classId: string): Promise<Booking[]> {
  return bookingsRepo(ctx).list({ filter: { classId } });
}

export interface ListBookingsQuery {
  memberId?: string;
  classId?: string;
  status?: Booking['status'];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function bookingFilter(query: ListBookingsQuery): Filter {
  const filter: Filter = {};
  if (query.memberId) filter.memberId = query.memberId;
  if (query.classId) filter.classId = query.classId;
  if (query.status) filter.status = query.status;
  if (query.from || query.to) {
    filter.bookedAt = {
      ...(query.from ? { $gte: new Date(query.from).toISOString() } : {}),
      ...(query.to ? { $lte: new Date(query.to).toISOString() } : {}),
    } as never;
  }
  return filter;
}

export async function listBookings(ctx: CoreContext, query: ListBookingsQuery = {}): Promise<Booking[]> {
  const rows = await bookingsRepo(ctx).list({
    filter: bookingFilter(query),
    order: { field: 'bookedAt', dir: 'desc' },
  });
  const offset = query.offset ?? 0;
  const limit = query.limit ?? rows.length;
  return rows.slice(offset, offset + limit);
}

export async function countBookings(ctx: CoreContext, query: ListBookingsQuery = {}): Promise<number> {
  return bookingsRepo(ctx).count({ filter: bookingFilter(query) });
}

export async function listBookingsWithContext(
  ctx: CoreContext,
  query: ListBookingsQuery = {},
): Promise<BookingWithContext[]> {
  const bookings = await listBookings(ctx, query);
  if (!bookings.length) return [];
  const [members, classes] = await Promise.all([
    ctx.repo.table('members').list(),
    ctx.repo.table('classes').list(),
  ]);
  const memberName = new Map(members.map((m) => [m.id, m.name] as const));
  const classById = new Map(classes.map((c) => [c.id, c] as const));
  return bookings.map((booking) => {
    const klass = classById.get(booking.classId);
    return {
      ...booking,
      memberName: memberName.get(booking.memberId),
      className: klass?.name,
      instructorId: klass?.instructorId,
      startTime: klass?.startTime,
    };
  });
}

export async function memberBookings(
  ctx: CoreContext,
  memberId: string,
  options: { status?: Booking['status']; includePast?: boolean } = {},
): Promise<BookingWithContext[]> {
  const rows = await listBookingsWithContext(ctx, { memberId, status: options.status });
  if (options.includePast === false) {
    const nowIso = ctx.now().toISOString();
    return rows.filter((b) => !b.startTime || b.startTime >= nowIso);
  }
  return rows;
}

export async function classRoster(ctx: CoreContext, classId: string) {
  const [bookings, members, attendance] = await Promise.all([
    bookingsRepo(ctx).list({ filter: { classId } }),
    ctx.repo.table('members').list(),
    ctx.repo.table('attendance').list({ filter: { classId } }),
  ]);
  const memberById = new Map(members.map((m) => [m.id, m] as const));
  const checkedIn = new Set(attendance.map((a) => a.bookingId ?? a.memberId));
  return sortBy(
    bookings.map((booking) => ({
      bookingId: booking.id,
      memberId: booking.memberId,
      memberName: memberById.get(booking.memberId)?.name ?? 'Unknown',
      status: booking.status,
      waitlistPosition: booking.waitlistPosition,
      checkedIn: checkedIn.has(booking.id) || checkedIn.has(booking.memberId),
      bookedAt: booking.bookedAt,
      source: booking.source,
    })),
    (row) => row.status === 'waitlisted' ? `1-${String(row.waitlistPosition ?? 0).padStart(4, '0')}` : `0-${row.memberName}`,
    'asc',
  );
}

export interface ClassCapacity {
  classId: string;
  capacity: number;
  confirmed: number;
  waitlisted: number;
  spotsLeft: number;
  isFull: boolean;
  canWaitlist: boolean;
}

export async function classCapacity(ctx: CoreContext, classId: string): Promise<ClassCapacity> {
  const klass = await ctx.repo.table('classes').findById(classId);
  if (!klass) throw notFound('Class', classId);
  const live = await liveBookings(ctx, classId);
  const confirmed = live.filter((b) => b.status === 'booked' || b.status === 'attended').length;
  const waitlisted = live.filter((b) => b.status === 'waitlisted').length;
  return {
    classId,
    capacity: klass.capacity,
    confirmed,
    waitlisted,
    spotsLeft: Math.max(0, klass.capacity - confirmed),
    isFull: confirmed >= klass.capacity,
    canWaitlist: (klass.waitlistEnabled ?? true) && (await hasFeature(ctx, 'waitlist')),
  };
}

/** Spots freed by X, used by the roster "reserve" flow. */
export async function freeSpotsAfterCancellation(ctx: CoreContext, classId: string, hours = 12): Promise<number> {
  const klass = await ctx.repo.table('classes').findById(classId);
  if (!klass) return 0;
  if (Date.parse(klass.startTime) > addHours(ctx.now(), hours).getTime()) return 0;
  const capacity = await classCapacity(ctx, classId);
  return capacity.spotsLeft;
}

export { sortBy };