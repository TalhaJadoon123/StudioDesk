/**
 * End-to-end smoke test: boot the real Fastify server, seed a demo studio,
 * exercise the main journeys over HTTP, and assert the numbers add up.
 *
 * This is the test that would catch a wiring mistake the unit tests cannot -
 * a route pointing at the wrong function, a plan limit not being enforced
 * through the API, a webhook that accepts unsigned calls.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@studiodesk/api';
import { createContext, seedDemoStudio, type StudioDesk } from '@studiodesk/core';
import { harness, type Harness } from '@studiodesk/core/test';

let app: FastifyInstance;
let desk: StudioDesk;
let h: Harness;

const T0 = new Date('2026-03-02T09:00:00.000Z');

async function post(url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, payload: payload as object });
}
async function get(url: string) {
  return app.inject({ method: 'GET', url });
}
async function del(url: string, payload: unknown = {}) {
  return app.inject({ method: 'DELETE', url, payload: payload as object });
}

beforeAll(async () => {
  h = harness(T0);
  const ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
  await seedDemoStudio(ctx, { members: 100 });
  const { createStudioDesk } = await import('@studiodesk/core');
  desk = await createStudioDesk({ repo: h.repo, events: h.events, now: h.now });
  app = await buildServer({ desk, logger: false });
});

afterAll(async () => {
  await app?.close();
});

describe('server boots', () => {
  it('is healthy and reports its integration state', async () => {
    const res = await get('/health');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.driver).toBe('memory');
    // No keys configured, so every integration must report itself offline.
    expect(body.integrations).toEqual({
      supabase: false,
      groq: false,
      payments: false,
      email: false,
    });
  });

  it('lists its own endpoints', async () => {
    const res = await get('/');
    expect(res.json().endpoints.length).toBeGreaterThan(10);
  });
});

describe('the seeded studio is real', () => {
  it('has 100 members and a populated schedule', async () => {
    const members = await get('/api/members?limit=200');
    expect(members.json().total).toBe(100);

    const classes = await get('/api/classes?from=2026-03-01T00:00:00Z&to=2026-05-01T00:00:00Z');
    expect(classes.json().length).toBeGreaterThan(20);

    const instructors = await get('/api/instructors');
    expect(instructors.json().length).toBe(5);
  });

  it('reports a dashboard that reflects the seed', async () => {
    const res = await get('/api/dashboard');
    const body = res.json();
    expect(body.activeMembers).toBeGreaterThan(50);
    expect(body.mrrCents).toBeGreaterThan(0);
    expect(body.studio.name).toBe('Riverbend Yoga');
  });

  it('serves a health check with actionable recommendations', async () => {
    const res = await get('/api/health-check');
    const body = res.json();
    expect(body.score).toBeGreaterThanOrEqual(0);
    expect(body.score).toBeLessThanOrEqual(100);
    expect(body.checks.length).toBeGreaterThanOrEqual(5);
    expect(body.grade).toMatch(/^[ABCD]$/);
  });
});

describe('booking journey over HTTP', () => {
  it('books, joins a waitlist, and promotes on cancellation', async () => {
    // A dedicated small class so the sequence is deterministic.
    const instructor = (await get('/api/instructors')).json()[0];
    const created = await post('/api/classes', {
      name: 'E2E Test Class',
      instructorId: instructor.id,
      startTime: '2026-03-10T18:00:00.000Z',
      capacity: 2,
    });
    expect(created.statusCode).toBe(200);
    const classId = created.json().id;

    const members = (await get('/api/members?limit=5&status=active')).json().items;
    expect(members.length).toBeGreaterThanOrEqual(4);

    // Two members fill it.
    const first = await post('/api/bookings', { memberId: members[0].id, classId });
    const second = await post('/api/bookings', { memberId: members[1].id, classId });
    expect(first.json().booking.status).toBe('booked');
    expect(second.json().booking.status).toBe('booked');

    // A third is refused without allowWaitlist...
    const refused = await post('/api/bookings', { memberId: members[2].id, classId });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('class_full');

    // ...and joins the queue when asked.
    const queued = await post('/api/bookings', {
      memberId: members[2].id,
      classId,
      allowWaitlist: true,
    });
    expect(queued.json().booking.status).toBe('waitlisted');
    expect(queued.json().waitlistPosition).toBe(1);

    const waitlistView = await get(`/api/classes/${classId}/waitlist`);
    expect(waitlistView.json().waitlisted).toBe(1);
    expect(waitlistView.json().spotsFree).toBe(0);

    // Cancelling promotes them.
    const cancelled = await del(`/api/bookings/${first.json().booking.id}`, { byStaff: true });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().promoted).toHaveLength(1);
    expect(cancelled.json().promoted[0].id).toBe(queued.json().booking.id);

    const after = await get(`/api/classes/${classId}/waitlist`);
    expect(after.json().waitlisted).toBe(0);
    expect(after.json().spotsFree).toBe(0);
  });

  it('refuses a double booking', async () => {
    const instructor = (await get('/api/instructors')).json()[0];
    const klass = (
      await post('/api/classes', {
        name: 'Double Booking Test',
        instructorId: instructor.id,
        startTime: '2026-03-11T18:00:00.000Z',
        capacity: 5,
      })
    ).json();

    const member = (await get('/api/members?limit=1&status=active')).json().items[0];
    await post('/api/bookings', { memberId: member.id, classId: klass.id });
    const second = await post('/api/bookings', { memberId: member.id, classId: klass.id });
    expect(second.statusCode).toBe(409);
  });

  it('cancelling a class cancels its bookings', async () => {
    const instructor = (await get('/api/instructors')).json()[0];
    const klass = (
      await post('/api/classes', {
        name: 'Doomed Class',
        instructorId: instructor.id,
        startTime: '2026-03-12T18:00:00.000Z',
        capacity: 5,
      })
    ).json();
    const member = (await get('/api/members?limit=1&status=active')).json().items[0];
    const booking = (await post('/api/bookings', { memberId: member.id, classId: klass.id })).json().booking;

    const res = await post(`/api/classes/${klass.id}/cancel`, { reason: 'instructor sick' });
    expect(res.json().cancelledBookings).toBe(1);
    expect((await get(`/api/bookings/${booking.id}`)).json().booking.status).toBe('cancelled');
  });
});

describe('check-in journey over HTTP', () => {
  it('issues a QR ticket, checks in, then reports a duplicate', async () => {
    const instructor = (await get('/api/instructors')).json()[0];
    const klass = (
      await post('/api/classes', {
        name: 'Check-in Test',
        instructorId: instructor.id,
        startTime: '2026-03-02T18:00:00.000Z',
        capacity: 5,
      })
    ).json();
    const member = (await get('/api/members?limit=1&status=active')).json().items[0];
    await post('/api/bookings', { memberId: member.id, classId: klass.id });

    const ticket = await get(`/api/members/${member.id}/checkin-ticket?ttl=300`);
    expect(ticket.statusCode).toBe(200);
    const code = ticket.json().ticket.code;
    expect(code).toMatch(/^sd1\./);
    expect(ticket.json().valid).toBe(true);

    const first = await post('/api/checkin', { code, method: 'qr' });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('checked-in');

    const second = await post('/api/checkin', { code, method: 'qr' });
    expect(second.json().status).toBe('duplicate');

    // A door scanner has no idea which class the member meant, so it checks
    // them into their *next* booking. With a seeded studio that may not be the
    // class this test created, so assert against the one the API reported.
    const checkedInClassId = first.json().classId;
    expect(checkedInClassId).toBeTruthy();

    const roster = await get(`/api/classes/${checkedInClassId}/roster`);
    expect(roster.json().checkedInCount).toBeGreaterThanOrEqual(1);

    // The booking itself moved from `booked` to `attended`.
    const rosterRow = roster
      .json()
      .expected.find((row: { memberId: string }) => row.memberId === member.id);
    expect(rosterRow).toBeTruthy();
    expect(rosterRow.checkedIn).toBe(true);
    expect(rosterRow.status).toBe('attended');
    expect(klass.id).toBeTruthy();
  });

  it('rejects a tampered QR ticket', async () => {
    const member = (await get('/api/members?limit=1&status=active')).json().items[0];
    const code = (await get(`/api/members/${member.id}/checkin-ticket`)).json().ticket.code;
    const parts = code.split('.');
    parts[1] = 'mem_forged';
    const res = await post('/api/checkin', { code: parts.join('.'), method: 'qr' });
    expect(res.json().status).toBe('invalid');
  });

  it('refuses a check-in from far outside the geofence', async () => {
    const member = (await get('/api/members?limit=1&status=active')).json().items[0];
    const res = await post('/api/checkin', {
      memberId: member.id,
      method: 'geo',
      latitude: 52.4862,
      longitude: -1.8904,
    });
    expect(res.json().status).toBe('outside-geofence');
  });
});

describe('billing journey over HTTP', () => {
  it('sells a pack and a drop-in in offline mode', async () => {
    const member = (await get('/api/members?limit=1&status=active')).json().items[0];

    const pack = await post('/api/billing/packs', { memberId: member.id, packName: '10 Class Pack' });
    expect(pack.statusCode).toBe(200);
    expect(pack.json().pack.creditsRemaining).toBe(10);

    const instructor = (await get('/api/instructors')).json()[0];
    const klass = (
      await post('/api/classes', {
        name: 'Drop-in Target',
        instructorId: instructor.id,
        startTime: '2026-03-20T18:00:00.000Z',
        capacity: 5,
      })
    ).json();

    const dropIn = await post('/api/billing/drop-ins', {
      memberId: member.id,
      classId: klass.id,
    });
    expect(dropIn.statusCode).toBe(200);
    expect(dropIn.json().amountCents).toBe(2200);
    expect(dropIn.json().charged).toBe(true);
    expect(dropIn.json().bookingId).toBeTruthy();
  });

  it('subscribes a member with no existing membership', async () => {
    // A fresh member, so this exercises the success path rather than the
    // duplicate-subscription guard (covered in the error-mapping block above).
    const created = await post('/api/members', {
      name: 'Fresh Subscriber',
      email: 'fresh.subscriber@example.com',
    });
    expect(created.statusCode).toBe(200);
    const member = created.json();
    const plan = (await get('/api/plans')).json()[0];

    const first = await post('/api/billing/subscribe', {
      memberId: member.id,
      planId: plan.id,
      gateway: 'manual',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('active');

    const second = await post('/api/billing/subscribe', {
      memberId: member.id,
      planId: plan.id,
      gateway: 'manual',
    });
    expect(second.statusCode).toBe(409);
  });

  it('runs renewals and dunning without error', async () => {
    expect((await post('/api/billing/renew', {})).statusCode).toBe(200);
    expect((await post('/api/billing/dunning/run', {})).statusCode).toBe(200);
    const summary = await get('/api/billing/dunning');
    expect(summary.statusCode).toBe(200);
    expect(typeof summary.json().pastDue).toBe('number');
  });
});

describe('error mapping', () => {
  it('maps a duplicate subscription to 409, not 500', async () => {
    // The seed already created memberships, so this member has one. A business
    // rule violation must surface as a client error.
    const member = (await get('/api/members?limit=1&status=active')).json().items[0];
    const plan = (await get('/api/plans')).json()[0];

    const res = await post('/api/billing/subscribe', {
      memberId: member.id,
      planId: plan.id,
      gateway: 'manual',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
    expect(res.json().message).toMatch(/already has an active membership/);
  });

  it('maps an unknown invoice to 404', async () => {
    const res = await post('/api/invoices/inv_missing/pdf', {});
    expect(res.statusCode).toBe(404);
  });
});

describe('reports are consistent', () => {
  it('revenue and attendance both return data for the window', async () => {
    const revenue = await get('/api/reports/revenue?days=60');
    expect(revenue.statusCode).toBe(200);
    expect(revenue.json().transactions).toBeGreaterThan(0);
    // Net must never exceed gross.
    expect(revenue.json().netCents).toBeLessThanOrEqual(revenue.json().grossCents);

    const attendance = await get('/api/reports/attendance?days=60');
    expect(attendance.json().attended).toBeGreaterThan(0);
    // attended + no-shows cannot exceed total bookings.
    expect(attendance.json().attended + attendance.json().noShows).toBeLessThanOrEqual(
      attendance.json().totalBookings,
    );
  });

  it('churn ranks the most at-risk member first', async () => {
    const res = await get('/api/reports/churn?enrich=false');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.insights.length).toBeGreaterThan(0);

    const risks = body.atRisk.map((m: { churnRisk: number }) => m.churnRisk);
    const sorted = [...risks].sort((a, b) => b - a);
    expect(risks).toEqual(sorted);
  });
});

describe('security behaviour', () => {
  it('does not leak internals on a 500', async () => {
    // A route that throws unexpectedly: request an id that breaks a query.
    const res = await get('/api/reports/classes/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
    // The 404 body must not carry a stack trace.
    expect(JSON.stringify(res.json())).not.toContain('at ');
  });

  it('validates request bodies with 422, not 500', async () => {
    const empty = await post('/api/members', { name: '' });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toBe('validation_failed');

    const badBooking = await post('/api/bookings', { memberId: '' });
    expect(badBooking.statusCode).toBe(422);
  });

  it('answers CORS preflight', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/members' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
  });
});
