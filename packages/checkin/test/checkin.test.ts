import { beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '@studiodesk/core';
import { recordAttendance, walkIn } from '@studiodesk/core';
import {
  checkGeofence,
  checkin,
  claimDevice,
  createPairing,
  deviceToken,
  fillStatus,
  geoCheckin,
  haversineMeters,
  isPairingValid,
  isReliableAccuracy,
  issueTicket,
  kioskCheckin,
  kioskLanding,
  kioskMemberSearch,
  staffCheckin,
  qrCheckin,
  recentCheckins,
  ensureKioskPins,
  setCheckinClock,
  undoCheckin,
  verifyTicket,
  withinBoundingBox,
  classRosterForCheckin,
} from '@studiodesk/checkin';
import {
  harness,
  seedClass,
  seedInstructor,
  seedMembers,
  seedPlan,
  seedStudio,
  type Harness,
} from '@studiodesk/core/test';

const CHECKIN_SECRET = 'test-checkin-secret';
const LONDON = { latitude: 51.5074, longitude: -0.1278 };

let h: Harness;
let ctx: ReturnType<typeof createContext>;

beforeEach(async () => {
  process.env.CHECKIN_SIGNING_SECRET = CHECKIN_SECRET;
  h = harness(new Date('2026-03-02T09:00:00.000Z'));
  ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
  // Ticket minting/verification must follow the same pinned clock.
  setCheckinClock(h.now);
  await seedStudio(h, 'business');
  await seedInstructor(h);
  await seedPlan(h);
});

describe('geo maths', () => {
  it('measures distance between two points', () => {
    expect(haversineMeters(LONDON, LONDON)).toBe(0);
    // London -> Paris is ~340km.
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    expect(Math.round(haversineMeters(LONDON, paris) / 1000)).toBeGreaterThan(330);
    expect(Math.round(haversineMeters(LONDON, paris) / 1000)).toBeLessThan(350);
  });

  it('does a cheap bounding-box precheck', () => {
    expect(withinBoundingBox({ latitude: 51.508, longitude: -0.128 }, LONDON, 150)).toBe(true);
    expect(withinBoundingBox({ latitude: 51.6, longitude: -0.1278 }, LONDON, 150)).toBe(false);
  });

  it('judges GPS accuracy', () => {
    expect(isReliableAccuracy(30)).toBe(true);
    expect(isReliableAccuracy(80)).toBe(false);
    expect(isReliableAccuracy(undefined)).toBe(true);
  });
});

describe('QR tickets', () => {
  it('issues and verifies a ticket', async () => {
    const ticket = await issueTicket('mem_001', { ttlSeconds: 120 });
    expect(ticket.code.startsWith('sd1.mem_001.')).toBe(true);
    const result = await verifyTicket(ticket.code);
    expect(result.valid).toBe(true);
    expect(result.memberId).toBe('mem_001');
  });

  it('rejects an expired ticket', async () => {
    const ticket = await issueTicket('mem_001', { ttlSeconds: 60 });
    h.advance(120);
    const result = await verifyTicket(ticket.code);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('rejects tampering with the member id', async () => {
    const ticket = await issueTicket('mem_001');
    const parts = ticket.code.split('.');
    parts[1] = 'mem_999';
    const result = await verifyTicket(parts.join('.'));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('bad-signature');
  });

  it('rejects extending the expiry', async () => {
    const ticket = await issueTicket('mem_001', { ttlSeconds: 60 });
    const parts = ticket.code.split('.');
    parts[3] = String(Math.floor(Date.now() / 1000) + 99_999);
    const result = await verifyTicket(parts.join('.'));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('bad-signature');
  });

  it('rejects a signature made with a different secret', async () => {
    const ticket = await issueTicket('mem_001', { secret: 'other' });
    const result = await verifyTicket(ticket.code);
    expect(result.valid).toBe(false);
  });

  it('rejects malformed payloads', async () => {
    expect((await verifyTicket('garbage')).reason).toBe('malformed');
    expect((await verifyTicket('')).reason).toBe('malformed');
    expect((await verifyTicket('sd2.a.b.c.d')).reason).toBe('malformed');
  });

  it('issues a fresh nonce each time', async () => {
    const a = await issueTicket('mem_001');
    const b = await issueTicket('mem_001');
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('geofence check-in', () => {
  it('accepts a member standing at the studio', async () => {
    const check = await checkGeofence(ctx, { latitude: 51.5075, longitude: -0.1279, accuracyMeters: 20 });
    expect(check.inside).toBe(true);
    expect(check.reason).toBeUndefined();
  });

  it('rejects a member who is far away', async () => {
    const check = await checkGeofence(ctx, { latitude: 52.4862, longitude: -1.8904, accuracyMeters: 20 });
    expect(check.inside).toBe(false);
    expect(check.reason).toBe('too-far');
    expect(check.distanceMeters).toBeGreaterThan(150);
  });

  it('allows more slack when GPS is imprecise', async () => {
    const fuzzy = { latitude: 51.5088, longitude: -0.1278 };
    const precise = await checkGeofence(ctx, { ...fuzzy, accuracyMeters: 10 });
    const inaccurate = await checkGeofence(ctx, { ...fuzzy, accuracyMeters: 180 });
    expect(precise.inside).toBe(false);
    expect(inaccurate.inside).toBe(true);
    expect(inaccurate.accuracyPenaltyMeters).toBeGreaterThan(0);
  });

  it('explains why a check-in was refused', async () => {
    const check = await checkGeofence(ctx, { latitude: 51.6, longitude: -0.1278 });
    const { geoCheckin: _ } = { geoCheckin };
    const result = await geoCheckin(ctx, {
      memberId: 'mem_001',
      point: { latitude: 51.6, longitude: -0.1278 },
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('km');
    void check;
    void _;
  });

  it('records attendance inside the fence', async () => {
    const [member] = await seedMembers(h, 1);
    const klass = await seedClass(h, { id: 'cls_1', startTime: h.at(0, 9) });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: member!.id,
      classId: klass.id,
      status: 'booked',
    });

    const result = await geoCheckin(ctx, {
      memberId: member!.id,
      classId: klass.id,
      point: { latitude: 51.5075, longitude: -0.1279, accuracyMeters: 15 },
    });
    expect(result.accepted).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(await h.repo.table('attendance').count()).toBe(1);
    // The booking is marked attended.
    expect((await h.repo.table('bookings').findById('bkg_1'))!.status).toBe('attended');
  });

  it('lets staff override the fence', async () => {
    const [member] = await seedMembers(h, 1);
    const result = await geoCheckin(ctx, {
      memberId: member!.id,
      point: { latitude: 51.6, longitude: -0.1278 },
      override: true,
    });
    expect(result.accepted).toBe(true);
  });
});

describe('checkin orchestrator', () => {
  it('checks a member in by QR code', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h, { id: 'cls_1', startTime: h.at(0, 9) });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: seeded[0]!.id,
      classId: klass.id,
      status: 'booked',
    });

    const ticket = await issueTicket(seeded[0]!.id);
    const result = await qrCheckin(ctx, { code: ticket.code });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('checked-in');
    expect(result.memberId).toBe(seeded[0]!.id);
  });

  it('rejects an invalid code with a helpful message', async () => {
    const result = await qrCheckin(ctx, { code: 'sd1.mem_001.a.b.c' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not valid/);
  });

  it('rejects a scan for a cancelled member', async () => {
    const seeded = await seedMembers(h, 1);
    await h.repo.table('members').update(seeded[0]!.id, { status: 'cancelled' });
    const ticket = await issueTicket(seeded[0]!.id);
    const result = await qrCheckin(ctx, { code: ticket.code });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cancelled/);
  });

  it('reports a duplicate scan instead of double-counting', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h, { id: 'cls_1', startTime: h.at(0, 9) });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: seeded[0]!.id,
      classId: klass.id,
      status: 'booked',
    });

    const ticket = await issueTicket(seeded[0]!.id);
    await qrCheckin(ctx, { code: ticket.code });
    const second = await qrCheckin(ctx, { code: ticket.code });
    expect(second.status).toBe('duplicate');
    expect(await h.repo.table('attendance').count()).toBe(1);
  });

  it('falls back to the next upcoming class when no class is given', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h, { id: 'cls_1', startTime: h.at(0, 9) });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: seeded[0]!.id,
      classId: klass.id,
      status: 'booked',
    });
    const result = await checkin(ctx, { memberId: seeded[0]!.id, method: 'manual' });
    expect(result.ok).toBe(true);
    expect(result.classId).toBe(klass.id);
  });

  it('reports when someone has nothing booked', async () => {
    const seeded = await seedMembers(h, 1);
    const result = await checkin(ctx, { memberId: seeded[0]!.id, method: 'manual' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not-booked');
    expect(result.message).toMatch(/no upcoming booking/);
  });

  it('validates input', async () => {
    expect((await checkin(ctx, { method: 'qr' })).status).toBe('invalid');
    expect((await checkin(ctx, { method: 'geo' })).status).toBe('invalid');
    expect((await checkin(ctx, { method: 'manual' })).status).toBe('invalid');
  });
});

describe('manual check-in and walk-ins', () => {
  it('creates a booking for a walk-in', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h, { id: 'cls_1', startTime: h.at(0, 9) });
    const result = await staffCheckin(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    expect(result.ok).toBe(true);
    expect(result.createdBooking).toBe(true);
    expect(await h.repo.table('bookings').count()).toBe(1);
  });

  it('does not double-book a member already booked', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h, { id: 'cls_1' });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: seeded[0]!.id,
      classId: klass.id,
      status: 'booked',
    });
    await staffCheckin(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    expect(await h.repo.table('bookings').count()).toBe(1);
  });

  it('undoes a mistaken check-in', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await seedClass(h, { id: 'cls_1' });
    const { attendance } = await walkIn(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    expect(await undoCheckin(ctx, attendance.id)).toBe(true);
    expect(await h.repo.table('attendance').count()).toBe(0);
    // The booking reverts to booked so they can check in again.
    expect((await h.repo.table('bookings').findOne({ filter: { memberId: seeded[0]!.id } }))!.status).toBe('booked');
  });

  it('lists recent check-ins for the front desk', async () => {
    const seeded = await seedMembers(h, 2);
    const klass = await seedClass(h, { id: 'cls_1' });
    await walkIn(ctx, { memberId: seeded[0]!.id, classId: klass.id });
    await walkIn(ctx, { memberId: seeded[1]!.id, classId: klass.id });
    const recent = await recentCheckins(ctx);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.memberName).toBeTruthy();
  });
});

describe('kiosk mode', () => {
  it('pairs a device with a code', async () => {
    const pairing = await createPairing();
    expect(pairing.claimCode).toMatch(/^\d{4}$/);
    expect(isPairingValid(pairing, h.now())).toBe(true);

    const device = await claimDevice(ctx, {
      claimCode: pairing.claimCode,
      name: 'Front desk iPad',
      pairing,
    });
    expect(device.active).toBe(true);
    expect(device.pin).toBe(pairing.claimCode);
  });

  it('rejects a wrong code and an expired pairing', async () => {
    const pairing = await createPairing();
    await expect(
      claimDevice(ctx, { claimCode: '0000', name: 'x', pairing }),
    ).rejects.toThrow(/Incorrect/);

    h.advance(600);
    await expect(
      claimDevice(ctx, { claimCode: pairing.claimCode, name: 'x', pairing }),
    ).rejects.toThrow(/expired/);
  });

  it('checks a member in from the kiosk without a booking', async () => {
    const seeded = await seedMembers(h, 1, () => ({ name: 'Kiosk Member' }));
    const pairing = await createPairing();
    const device = await claimDevice(ctx, {
      claimCode: pairing.claimCode,
      name: 'Tablet',
      pairing,
    });
    const klass = await seedClass(h, { id: 'cls_kiosk', startTime: h.at(0, 9) });

    const result = await kioskCheckin(ctx, {
      deviceId: device.id,
      memberId: seeded[0]!.id,
      classId: klass.id,
    });
    expect(result.ok).toBe(true);
    expect(await h.repo.table('attendance').count()).toBe(1);
  });

  it('rejects an unregistered device', async () => {
    await expect(
      kioskCheckin(ctx, { deviceId: 'dev_nope', memberId: 'mem_001' }),
    ).rejects.toThrow(/not registered/);
  });

  it('builds the kiosk landing screen', async () => {
    const pairing = await createPairing();
    const device = await claimDevice(ctx, { claimCode: pairing.claimCode, name: 'Tablet', pairing });
    // The kiosk shows *today's* classes, so both must land on day 0.
    await seedClass(h, { id: 'cls_a', startTime: h.at(0, 9) });
    await seedClass(h, { id: 'cls_b', startTime: h.at(0, 18) });

    const landing = await kioskLanding(ctx, device.id);
    expect(landing.device.name).toBe('Tablet');
    expect(landing.classes.length).toBe(2);
    expect(landing.defaultClassId).toBe('cls_a');
  });

  it('searches members for the kiosk', async () => {
    await seedMembers(h, 5);
    const results = await kioskMemberSearch(ctx, 'Member 002');
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('Member 002');
  });

  it('issues kiosk PINs', async () => {
    await seedMembers(h, 3);
    expect(await ensureKioskPins(ctx)).toBe(3);
    // Second run is a no-op.
    expect(await ensureKioskPins(ctx)).toBe(0);
  });

  it('mints a device token', () => {
    expect(deviceToken('dev_abc')).toMatch(/^kiosk_devabc_/);
  });
});

describe('roll call', () => {
  it('lists who is expected and who is here', async () => {
    const seeded = await seedMembers(h, 3);
    const klass = await seedClass(h, { id: 'cls_1', startTime: h.at(0, 9) });
    for (let i = 0; i < 2; i += 1) {
      await h.repo.table('bookings').insert({
        id: `bkg_${i}`,
        memberId: seeded[i]!.id,
        classId: klass.id,
        status: 'booked',
      });
    }
    await recordAttendance(ctx, { memberId: seeded[0]!.id, classId: klass.id, method: 'qr' });

    const roster = await classRosterForCheckin(ctx, klass.id);
    expect(roster.expected).toHaveLength(2);
    expect(roster.checkedInCount).toBe(1);
    expect(roster.noShowCount).toBe(1);
  });

  it('reports fill status', async () => {
    const seeded = await seedMembers(h, 2);
    const klass = await seedClass(h, { id: 'cls_1', capacity: 4 });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: seeded[0]!.id,
      classId: klass.id,
      status: 'booked',
    });
    const status = await fillStatus(ctx, klass.id);
    expect(status.fillRate).toBe(0.25);
    expect(status.label).toBe('Plenty of space');
  });
});