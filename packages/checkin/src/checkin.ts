import type { CheckinResult } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { walkIn, listAttendance } from '@studiodesk/core';
import { setCheckinClock, verifyTicket } from './qr.js';
import { geoCheckin, type GeoPoint } from './mobile.js';

/**
 * Every check-in entrypoint installs the studio clock first, so ticket expiry,
 * booking grace windows and geofence maths all agree on "now".
 */
function withClock<T>(ctx: CoreContext, fn: () => T): T {
  setCheckinClock(ctx.now);
  return fn();
}

/**
 * The check-in orchestrator. One function per method, all returning the same
 * `CheckinResult` shape so the API, the kiosk and the app can share a client.
 */

export interface CheckinInput {
  memberId?: string;
  bookingId?: string;
  classId?: string;
  /** Scanned QR payload. */
  code?: string;
  method: 'qr' | 'geo' | 'manual' | 'kiosk';
  point?: GeoPoint;
  staffId?: string;
  deviceId?: string;
  /** Staff override for the geofence / capacity / membership rules. */
  override?: boolean;
}

function ok(partial: Partial<CheckinResult> & { message: string }): CheckinResult {
  return { ok: true, status: 'checked-in', ...partial } as CheckinResult;
}

/* -------------------------------------------------------------------------- */
/* QR                                                                         */
/* -------------------------------------------------------------------------- */

/** Scans a member's QR code at the studio door. */
export async function qrCheckin(
  ctx: CoreContext,
  input: Omit<CheckinInput, 'method' | 'code'> & { code: string; now?: Date },
): Promise<CheckinResult> {
  const ticket = await withClock(ctx, () => verifyTicket(input.code, { now: input.now }));
  if (!ticket.valid) {
    return {
      ok: false,
      status: 'invalid',
      message:
        ticket.reason === 'expired'
          ? 'That QR code has expired. Ask the member to refresh it.'
          : 'That QR code is not valid.',
    };
  }

  const memberId = ticket.memberId!;
  const result = await baseCheckin(ctx, {
    ...input,
    memberId,
    method: 'qr',
  });
  if (result.status === 'not-booked' && input.override) {
    return okWalkIn(ctx, memberId, input.classId, input.staffId);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Geo                                                                        */
/* -------------------------------------------------------------------------- */

export async function locationCheckin(
  ctx: CoreContext,
  input: Omit<CheckinInput, 'method' | 'point'> & { point: GeoPoint },
): Promise<CheckinResult> {
  if (!input.memberId) {
    return { ok: false, status: 'invalid', message: 'memberId is required for location check-in' };
  }

  const geo = await geoCheckin(ctx, {
    memberId: input.memberId,
    classId: input.classId,
    bookingId: input.bookingId,
    point: input.point,
    override: input.override,
  });
  setCheckinClock(ctx.now);

  if (!geo.accepted) {
    return {
      ok: false,
      status: 'outside-geofence',
      memberId: input.memberId,
      message: geo.reason ?? 'You are not at the studio.',
      distanceMeters: geo.distanceMeters,
    };
  }

  if (geo.duplicate) {
    const member = await ctx.repo.table('members').findById(input.memberId);
    return {
      ok: true,
      status: 'duplicate',
      memberId: input.memberId,
      memberName: member?.name,
      classId: input.classId,
      message: `${member?.name ?? 'Member'} is already checked in.`,
      distanceMeters: geo.distanceMeters,
    };
  }

  const member = await ctx.repo.table('members').findById(input.memberId);
  return ok({
    memberId: input.memberId,
    memberName: member?.name,
    classId: input.classId,
    distanceMeters: geo.distanceMeters,
    message: `Welcome in, ${member?.name ?? 'member'}.`,
  });
}

/* -------------------------------------------------------------------------- */
/* Manual / staff                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Staff check-in. If the member has no booking it creates one first, so a
 * walk-in never blocks the front desk.
 */
export async function manualCheckin(
  ctx: CoreContext,
  input: { memberId: string; classId: string; staffId?: string; override?: boolean },
): Promise<CheckinResult> {
  if (input.override) return okWalkIn(ctx, input.memberId, input.classId, input.staffId);

  const result = await baseCheckin(ctx, { ...input, method: 'manual' });
  if (result.status === 'not-booked') return okWalkIn(ctx, input.memberId, input.classId, input.staffId);
  return result;
}

async function okWalkIn(
  ctx: CoreContext,
  memberId: string,
  classId: string | undefined,
  staffId?: string,
): Promise<CheckinResult> {
  if (!classId) {
    return { ok: false, status: 'invalid', memberId, message: 'classId is required for a walk-in' };
  }
  const member = await ctx.repo.table('members').findById(memberId);
  try {
    const { attendance } = await walkIn(ctx, { memberId, classId, staffId });
    return ok({
      memberId,
      memberName: member?.name,
      classId,
      attendance,
      message: `${member?.name ?? 'Member'} checked in (walk-in).`,
    });
  } catch (error) {
    return {
      ok: false,
      status: 'not-booked',
      memberId,
      memberName: member?.name,
      classId,
      message: error instanceof Error ? error.message : 'Could not check in',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Looks up (or resolves) the booking and records attendance.
 *
 * If no `classId` is supplied we pick the member's next booked class, which is
 * what a door scanner should do.
 */
async function baseCheckin(
  ctx: CoreContext,
  input: CheckinInput & { memberId?: string },
): Promise<CheckinResult> {
  if (!input.memberId) {
    return { ok: false, status: 'invalid', message: 'memberId is required' };
  }

  const { recordAttendance } = await import('@studiodesk/core');
  const member = await ctx.repo.table('members').findById(input.memberId);
  if (!member) return { ok: false, status: 'invalid', message: 'That member does not exist' };
  if (member.status === 'cancelled') {
    return {
      ok: false,
      status: 'invalid',
      memberId: member.id,
      memberName: member.name,
      message: `${member.name}'s membership is cancelled.`,
    };
  }

  let classId = input.classId;
  let bookingId = input.bookingId;

  if (bookingId) {
    const booking = await ctx.repo.table('bookings').findById(bookingId);
    if (!booking) return { ok: false, status: 'not-booked', memberId: member.id, message: 'Booking not found' };
    classId = booking.classId;
    if (booking.status === 'attended') {
      return {
        ok: true,
        status: 'duplicate',
        memberId: member.id,
        memberName: member.name,
        classId,
        message: `${member.name} is already checked in.`,
      };
    }
    if (booking.status === 'cancelled') {
      return {
        ok: false,
        status: 'not-booked',
        memberId: member.id,
        memberName: member.name,
        classId,
        message: `${member.name} cancelled this booking.`,
      };
    }
  } else if (!classId) {
    // The class a door scanner should assume: the member's next booking that
    // has not started yet. Attended bookings are included so a second scan
    // reads as a duplicate rather than "no booking found".
    const live = (
      await ctx.repo.table('bookings').list({ filter: { memberId: member.id } })
    ).filter((b) => b.status === 'booked' || b.status === 'attended');

    // Already checked in for a class that is still running -> duplicate.
    const alreadyIn = await Promise.all(
      live
        .filter((b) => b.status === 'attended')
        .map(async (b) => ({ booking: b, klass: await ctx.repo.table('classes').findById(b.classId) })),
    );
    const activeCheckin = alreadyIn.find(
      ({ klass }) =>
        klass &&
        Date.parse(klass.startTime) + 6 * 3_600_000 > ctx.now().getTime(),
    );
    if (activeCheckin) {
      return {
        ok: true,
        status: 'duplicate',
        memberId: member.id,
        memberName: member.name,
        classId: activeCheckin.klass!.id,
        message: `${member.name} is already checked in.`,
      };
    }

    const upcoming = live
      .filter((b) => b.status === 'booked')
      .sort((a, b) => (a.bookedAt ?? '').localeCompare(b.bookedAt ?? ''));
    for (const booking of upcoming) {
      const klass = await ctx.repo.table('classes').findById(booking.classId);
      if (!klass) continue;
      if (Date.parse(klass.startTime) > ctx.now().getTime() - 6 * 3_600_000) {
        classId = klass.id;
        bookingId = booking.id;
        break;
      }
    }
    if (!classId) {
      return {
        ok: false,
        status: 'not-booked',
        memberId: member.id,
        memberName: member.name,
        message: `${member.name} has no upcoming booking to check into.`,
      };
    }
  }

  const result = await recordAttendance(ctx, {
    memberId: member.id,
    classId,
    bookingId,
    method: input.method,
    staffId: input.staffId,
    deviceId: input.deviceId,
  });

  if (result.duplicate) {
    return {
      ok: true,
      status: 'duplicate',
      memberId: member.id,
      memberName: member.name,
      classId,
      attendance: result.attendance,
      message: `${member.name} is already checked in.`,
    };
  }

  const klass = classId ? await ctx.repo.table('classes').findById(classId) : null;
  return ok({
    memberId: member.id,
    memberName: member.name,
    classId,
    attendance: result.attendance,
    message: `${member.name} checked in to ${klass?.name ?? 'class'}.`,
  });
}

/** Single entry point used by the API routes. */
export async function checkin(ctx: CoreContext, input: CheckinInput): Promise<CheckinResult> {
  switch (input.method) {
    case 'qr':
      if (!input.code) {
        return { ok: false, status: 'invalid', message: 'code is required for QR check-in' };
      }
      return qrCheckin(ctx, { ...input, code: input.code });
    case 'geo':
      if (!input.point) {
        return { ok: false, status: 'invalid', message: 'point is required for location check-in' };
      }
      return locationCheckin(ctx, { ...input, point: input.point });
    case 'manual':
    case 'kiosk': {
      if (!input.memberId) {
        return { ok: false, status: 'invalid', message: 'memberId is required' };
      }
      // With no classId, resolve the member's next booking rather than
      // reporting a misleading "invalid" (an empty classId is not a bad
      // request for a front-desk scan).
      if (!input.classId) {
        return baseCheckin(ctx, input);
      }
      return manualCheckin(ctx, {
        memberId: input.memberId,
        classId: input.classId,
        staffId: input.staffId,
        override: input.override,
      });
    }
    default:
      return { ok: false, status: 'invalid', message: `Unknown method ${input.method}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Roster                                                                     */
/* -------------------------------------------------------------------------- */

export interface CheckinRosterEntry {
  memberId: string;
  memberName: string;
  status: string;
  checkedIn: boolean;
  checkedInAt?: string;
  method?: string;
  waitlistPosition?: number;
}

/** Who is expected, who is here - the class roll call. */
export async function classRosterForCheckin(
  ctx: CoreContext,
  classId: string,
): Promise<{ expected: CheckinRosterEntry[]; checkedInCount: number; noShowCount: number }> {
  const { classRoster } = await import('@studiodesk/core');
  const [rows, attendance] = await Promise.all([
    classRoster(ctx, classId),
    listAttendance(ctx, { classId }),
  ]);
  const byMember = new Map(attendance.map((a) => [a.memberId, a] as const));

  // Everyone who was on the roster - including those who have already checked
  // in - so the roll call shows "expected" and "here" side by side.
  const expected: CheckinRosterEntry[] = rows
    .filter((row) => row.status === 'booked' || row.status === 'attended' || row.status === 'waitlisted')
    .map((row) => {
      const record = byMember.get(row.memberId);
      return {
        memberId: row.memberId,
        memberName: row.memberName,
        status: row.status,
        checkedIn: Boolean(record),
        checkedInAt: record?.checkedInAt,
        method: record?.method,
        waitlistPosition: row.waitlistPosition,
      };
    });

  return {
    expected,
    checkedInCount: expected.filter((entry) => entry.checkedIn).length,
    noShowCount: expected.filter((entry) => entry.status === 'booked' && !entry.checkedIn).length,
  };
}

/** Notifies the studio that a class is full or near capacity. */
export async function fillStatus(ctx: CoreContext, classId: string) {
  const { classCapacity } = await import('@studiodesk/core');
  const capacity = await classCapacity(ctx, classId);
  const pct = capacity.capacity ? capacity.confirmed / capacity.capacity : 0;
  return {
    ...capacity,
    fillRate: Number(pct.toFixed(3)),
    label: pct >= 1 ? 'Full' : pct >= 0.8 ? 'Nearly full' : pct >= 0.5 ? 'Filling up' : 'Plenty of space',
  };
}