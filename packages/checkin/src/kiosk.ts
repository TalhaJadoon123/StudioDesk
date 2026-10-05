import { newDeviceId } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { checkin, type CheckinInput } from './checkin.js';
import { createPairing, deviceToken, isPairingValid, type KioskPairing } from './qr.js';

/**
 * Kiosk / tablet mode.
 *
 * A tablet is claimed once by typing a short code shown on its screen into the
 * dashboard. After that it can run a large-target touch interface with no
 * login, which is what actually works at a front desk.
 */

export function devicesRepo(ctx: CoreContext) {
  return ctx.repo.table('devices');
}

export interface KioskDeviceRow {
  id: string;
  studioId: string;
  name: string;
  pin: string;
  location?: string;
  lastSeenAt?: string;
  active: boolean;
  createdAt: string;
}

/** Step 1 - the tablet asks for a pairing code. */
export async function beginPairing(
  ctx: CoreContext,
  options: { ttlSeconds?: number } = {},
): Promise<KioskPairing> {
  return createPairing(options);
}

/** Step 2 - the studio types the code into the dashboard to claim it. */
export async function claimDevice(
  ctx: CoreContext,
  input: { claimCode: string; name: string; location?: string; pin?: string; pairing?: KioskPairing },
): Promise<KioskDeviceRow> {
  if (input.pairing && !isPairingValid(input.pairing, ctx.now())) {
    throw new Error('That pairing code has expired. Refresh the tablet screen.');
  }
  const expected = input.pairing?.claimCode;
  if (expected && expected !== input.claimCode) {
    throw new Error('Incorrect pairing code');
  }
  if (!expected && input.claimCode.length < 4) {
    throw new Error('Enter the code shown on the tablet');
  }

  const existing = (await devicesRepo(ctx).list()).find((d) => d.pin === input.claimCode);
  if (existing) return existing;

  const device: KioskDeviceRow = {
    id: newDeviceId(),
    studioId: ctx.studioId ?? 'std_demo',
    name: input.name,
    pin: input.pin ?? input.claimCode,
    location: input.location,
    active: true,
    createdAt: ctx.now().toISOString(),
  };
  return devicesRepo(ctx).insert(device);
}

export async function listDevices(ctx: CoreContext): Promise<KioskDeviceRow[]> {
  return devicesRepo(ctx).list();
}

export async function deactivateDevice(ctx: CoreContext, id: string): Promise<boolean> {
  const device = await devicesRepo(ctx).findById(id);
  if (!device) return false;
  await devicesRepo(ctx).update(id, { active: false });
  return true;
}

/** Step 3 - the tablet checks a member in by tapping their photo or name. */
export async function kioskCheckin(
  ctx: CoreContext,
  input: { deviceId: string; memberId: string; classId?: string },
): Promise<CheckinInput & { ok: boolean }> {
  const device = await devicesRepo(ctx).findById(input.deviceId);
  if (!device || !device.active) {
    throw new Error('This tablet is not registered. Ask the studio to re-pair it.');
  }
  await devicesRepo(ctx).update(device.id, { lastSeenAt: ctx.now().toISOString() });

  const result = await checkin(ctx, {
    memberId: input.memberId,
    classId: input.classId,
    method: 'kiosk',
    deviceId: device.id,
    override: true,
  });

  // A kiosk always overrides membership state - the member is standing there.
  return { ...input, ...result } as never;
}

/** The screen the tablet renders: today's classes with live counts. */
export async function kioskLanding(ctx: CoreContext, deviceId: string) {
  const device = await devicesRepo(ctx).findById(deviceId);
  if (!device || !device.active) throw new Error('Unknown or deactivated device');

  const { todayClasses, classCapacity } = await import('@studiodesk/core');
  const classes = await todayClasses(ctx);
  const nowMs = ctx.now().getTime();

  const rows = await Promise.all(
    classes.map(async (klass) => {
      const capacity = await classCapacity(ctx, klass.id);
      return {
        classId: klass.id,
        name: klass.name,
        startTime: klass.startTime,
        timeLabel: klass.startTime.slice(11, 16),
        capacity: klass.capacity,
        confirmed: capacity.confirmed,
        waitlisted: capacity.waitlisted,
        spotsLeft: capacity.spotsLeft,
        isFull: capacity.isFull,
        isPast: Date.parse(klass.startTime) < nowMs,
        status: klass.status,
      };
    }),
  );

  return {
    device: { id: device.id, name: device.name, location: device.location },
    classes: rows,
    /** The class the tablet defaults to: the next one starting. */
    defaultClassId: rows.find((row) => !row.isPast)?.classId ?? rows[0]?.classId,
  };
}

/** Members matching a typed name/PIN fragment - the kiosk search box. */
export async function kioskMemberSearch(ctx: CoreContext, query: string, limit = 8) {
  const needle = query.trim().toLowerCase();
  const members = await ctx.repo.table('members').list({ filter: { status: 'active' } });
  const scored = members
    .filter((member) => !needle || member.name.toLowerCase().includes(needle) || member.kioskPin === needle)
    // Exact prefix matches first, then most recently active.
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
      return aPrefix - bPrefix || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
  return members.map((member) => ({
    id: member.id,
    name: member.name,
    planId: member.planId,
    hasPin: Boolean(member.kioskPin),
  })).filter((member) => !needle || scored.some((s) => s.id === member.id));
}

/** Every member gets a 4-digit PIN for kiosk sign-in. */
export async function ensureKioskPins(ctx: CoreContext): Promise<number> {
  const members = await ctx.repo.table('members').list();
  let updated = 0;
  for (const member of members) {
    if (member.kioskPin) continue;
    await ctx.repo
      .table('members')
      .update(member.id, { kioskPin: String(1000 + Math.floor(Math.random() * 9000)) });
    updated += 1;
  }
  return updated;
}

export { deviceToken };