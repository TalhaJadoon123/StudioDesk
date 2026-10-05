import { sortBy } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { walkIn, listAttendance } from '@studiodesk/core';

/**
 * Manual (staff-assisted) check-in.
 *
 * The front-desk path: find the member, tap check in. If they have no booking
 * the studio can still seat them as a walk-in, which is the single most
 * important behaviour in a real studio.
 */

export interface ManualCheckinResult {
  ok: boolean;
  memberId: string;
  memberName: string;
  classId?: string;
  attendanceId?: string;
  createdBooking: boolean;
  alreadyCheckedIn: boolean;
  message: string;
}

/**
 * Front-desk check-in. See `checkin.ts` for the shared `manualCheckin` used by
 * the API routes; this one is the richer dashboard-facing version.
 */
export async function staffCheckin(
  ctx: CoreContext,
  input: {
    memberId: string;
    classId?: string;
    staffId?: string;
    /** Seat even when the class is full or the member has no booking. */
    allowWalkIn?: boolean;
    /** Book and check in a member whose membership is paused. */
    override?: boolean;
  },
): Promise<ManualCheckinResult> {
  const member = await ctx.repo.table('members').findById(input.memberId);
  if (!member) throw new Error(`Member ${input.memberId} not found`);

  const existingBooking = await ctx.repo.table('bookings').findOne({
                                                            filter: {
    memberId: input.memberId,
    ...(input.classId ? { classId: input.classId } : {}),
    status: 'booked',
  
                                                          },
                                                          } as never);

  if (!existingBooking && (!input.classId || input.allowWalkIn === false)) {
    return {
      ok: false,
      memberId: member.id,
      memberName: member.name,
      createdBooking: false,
      alreadyCheckedIn: false,
      message: `${member.name} has no booking for that class.`,
    };
  }

  const { attendance, duplicate, booking } = await walkIn(ctx, {
    memberId: input.memberId,
    classId: input.classId ?? existingBooking!.classId,
    staffId: input.staffId,
  });

  return {
    ok: true,
    memberId: member.id,
    memberName: member.name,
    classId: attendance.classId,
    attendanceId: attendance.id,
    createdBooking: !existingBooking,
    alreadyCheckedIn: duplicate,
    message: duplicate
      ? `${member.name} was already checked in.`
      : `${member.name} checked in.`,
  };
}

/** Undo a mistaken check-in (staff hit the wrong person). */
export async function undoCheckin(ctx: CoreContext, attendanceId: string): Promise<boolean> {
  const attendance = await ctx.repo.table('attendance').findById(attendanceId);
  if (!attendance) return false;
  await ctx.repo.table('attendance').remove(attendanceId);
  if (attendance.bookingId) {
    await ctx.repo
      .table('bookings')
      .update(attendance.bookingId, { status: 'booked', updatedAt: ctx.now().toISOString() });
  }
  return true;
}

/** Recent check-ins for the studio's front-desk screen. */
export async function recentCheckins(ctx: CoreContext, limit = 20) {
  const attendance = await listAttendance(ctx, { limit });
  const members = await ctx.repo.table('members').list();
  const classes = await ctx.repo.table('classes').list();
  const memberName = new Map(members.map((m) => [m.id, m.name] as const));
  const className = new Map(classes.map((c) => [c.id, c.name] as const));

  return sortBy(
    attendance.map((row) => ({
      attendanceId: row.id,
      memberId: row.memberId,
      memberName: memberName.get(row.memberId) ?? 'Unknown',
      classId: row.classId,
      className: className.get(row.classId),
      checkedInAt: row.checkedInAt,
      method: row.method,
      lateByMinutes: row.lateByMinutes ?? 0,
    })),
    (row) => row.checkedInAt,
    'desc',
  ).slice(0, limit);
}

/** Member's own check-in history - the app's "My visits" tab. */
export async function memberCheckinHistory(ctx: CoreContext, memberId: string, limit = 30) {
  const attendance = await listAttendance(ctx, { memberId });
  const classes = await ctx.repo.table('classes').list();
  const classById = new Map(classes.map((c) => [c.id, c] as const));

  return sortBy(
    attendance.map((row) => ({
      attendanceId: row.id,
      classId: row.classId,
      className: classById.get(row.classId)?.name ?? 'Class',
      startTime: classById.get(row.classId)?.startTime ?? row.checkedInAt,
      checkedInAt: row.checkedInAt,
      method: row.method,
    })),
    (row) => row.checkedInAt,
    'desc',
  ).slice(0, limit);
}