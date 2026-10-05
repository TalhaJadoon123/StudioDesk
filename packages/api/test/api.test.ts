import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '@studiodesk/api';
import type { FastifyInstance } from 'fastify';
import { createContext, seedDemoStudio, type CoreContext } from '@studiodesk/core';
import { harness, seedInstructor, seedMembers, seedStudio, seedPlan, type Harness } from '@studiodesk/core/test';

let app: FastifyInstance;
let h: Harness;
let ctx: CoreContext;

beforeEach(async () => {
  h = harness(new Date('2026-03-02T09:00:00.000Z'));
  ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
  await seedStudio(h, 'business');
  await seedInstructor(h);
  await seedPlan(h);
  app = await buildServer({ desk: await makeDesk(), logger: false });
});

/** The API server takes a `StudioDesk`, not a raw context. */
async function makeDesk() {
  const { createStudioDesk } = await import('@studiodesk/core');
  return createStudioDesk({ repo: h.repo, events: h.events, now: h.now, withNotifications: true });
}

afterAll(async () => {
  await app?.close();
});

const json = (payload: unknown) => ({
  method: 'POST' as const,
  url: '',
  payload: payload as object,
});

describe('meta routes', () => {
  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.driver).toBe('memory');
  });

  it('lists endpoints at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json().endpoints.length).toBeGreaterThan(5);
  });

  it('404s unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('answers CORS preflight', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/members' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('members CRUD', () => {
  it('creates, reads, updates and lists', async () => {
    const created = await app.inject({
      ...json({ name: 'Ada Lovelace', email: 'ada@example.com' }),
      url: '/api/members',
    });
    expect(created.statusCode).toBe(200);
    const member = created.json();
    expect(member.name).toBe('Ada Lovelace');

    const fetched = await app.inject({ method: 'GET', url: `/api/members/${member.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().member.name).toBe('Ada Lovelace');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/members/${member.id}`,
      payload: { name: 'Ada King' },
    });
    expect(updated.json().name).toBe('Ada King');

    const list = await app.inject({ method: 'GET', url: '/api/members?limit=10' });
    expect(list.json().items.length).toBe(1);
    expect(list.json().total).toBe(1);
  });

  it('rejects an invalid payload with 422', async () => {
    const res = await app.inject({ ...json({ name: '' }), url: '/api/members' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('validation_failed');
  });

  it('returns 404 for an unknown member', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/members/mem_missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('pauses, resumes and cancels', async () => {
    await seedMembers(h, 1, () => ({}), { prefix: 'cycle' });
    const id = 'cycle_001';

    expect((await app.inject({ ...json({}), url: `/api/members/${id}/pause` })).json().status).toBe('paused');
    expect((await app.inject({ ...json({}), url: `/api/members/${id}/resume` })).json().status).toBe('active');
    const cancelled = await app.inject({
      ...json({ reason: 'moved' }),
      url: `/api/members/${id}/cancel`,
    });
    expect(cancelled.json().status).toBe('cancelled');
  });

  it('searches', async () => {
    await seedMembers(h, 5);
    const res = await app.inject({ method: 'GET', url: '/api/members?search=Member+003' });
    expect(res.json().items).toHaveLength(1);
  });
});

describe('plans and instructors', () => {
  it('creates a plan', async () => {
    const res = await app.inject({
      ...json({ name: '10 Class Pack', priceCents: 15000, classCredits: 10 }),
      url: '/api/plans',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().classCredits).toBe(10);
    const list = await app.inject({ method: 'GET', url: '/api/plans' });
    expect(list.json().length).toBeGreaterThan(1);
  });

  it('creates and lists instructors', async () => {
    const res = await app.inject({
      ...json({ name: 'New Instructor' }),
      url: '/api/instructors',
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/instructors' });
    expect(list.json().length).toBe(2);
  });

  it('rejects a class with an unknown instructor', async () => {
    const res = await app.inject({
      ...json({
        name: 'Yoga',
        instructorId: 'ins_missing',
        startTime: h.at(1, 9).toISOString(),
        capacity: 10,
      }),
      url: '/api/classes',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('classes and schedule', () => {
  it('creates a class and shows it in the schedule', async () => {
    const created = await app.inject({
      ...json({
        name: 'Vinyasa Flow',
        instructorId: 'ins_001',
        startTime: h.at(2, 18).toISOString(),
        capacity: 12,
      }),
      url: '/api/classes',
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().capacity).toBe(12);

    const schedule = await app.inject({
      method: 'GET',
      url: `/api/schedule?from=${h.at(0, 0).toISOString()}&to=${h.at(7, 0).toISOString()}`,
    });
    expect(schedule.json().summary.totalClasses).toBe(1);
  });

  it('cancels a class and its bookings', async () => {
    const seeded = await seedMembers(h, 1);
    const klass = await h.repo.table('classes').insert({
      id: 'cls_cancel',
      studioId: 'std_demo',
      name: 'To Cancel',
      instructorId: 'ins_001',
      startTime: h.at(2, 9).toISOString(),
      capacity: 10,
      status: 'scheduled',
    });
    await h.repo.table('bookings').insert({
      id: 'bkg_1',
      memberId: seeded[0]!.id,
      classId: klass.id,
      status: 'booked',
    });

    const res = await app.inject({
      ...json({ reason: 'instructor sick' }),
      url: `/api/classes/${klass.id}/cancel`,
    });
    expect(res.json().cancelledBookings).toBe(1);
    expect((await h.repo.table('bookings').findById('bkg_1'))!.status).toBe('cancelled');
  });

  it('previews a recurring series without saving', async () => {
    const res = await app.inject({
      ...json({
        rrule: 'DTSTART:20260302T090000Z\nFREQ=WEEKLY;BYDAY=MO,WE;COUNT=8',
        instructorId: 'ins_001',
        durationMinutes: 60,
      }),
      url: '/api/schedule/series/preview',
    });
    expect(res.json().count).toBe(8);
    expect(await h.repo.table('classes').count({ filter: { instructorId: 'ins_001' } })).toBe(0);
  });
});

describe('bookings', () => {
  it('books, cancels and reports the queue', async () => {
    const seeded = await seedMembers(h, 3, () => ({}), { prefix: 'book' });
    const klass = await h.repo.table('classes').insert({
      id: 'cls_book',
      studioId: 'std_demo',
      name: 'Small Class',
      instructorId: 'ins_001',
      startTime: h.at(1, 9).toISOString(),
      capacity: 1,
      status: 'scheduled',
      waitlistEnabled: true,
    });

    const booked = await app.inject({
      ...json({ memberId: 'book_001', classId: klass.id }),
      url: '/api/bookings',
    });
    expect(booked.json().booking.status).toBe('booked');

    // Second member hits the full class and gets class_full.
    const full = await app.inject({
      ...json({ memberId: 'book_002', classId: klass.id }),
      url: '/api/bookings',
    });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toBe('class_full');

    // With allowWaitlist they join the queue.
    const waitlisted = await app.inject({
      ...json({ memberId: 'book_002', classId: klass.id, allowWaitlist: true }),
      url: '/api/bookings',
    });
    expect(waitlisted.json().booking.status).toBe('waitlisted');
    expect(waitlisted.json().waitlistPosition).toBe(1);

    // Cancelling frees the spot and promotes the person at the front of the queue.
    const bookingId = booked.json().booking.id;
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/api/bookings/${bookingId}`,
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().promoted).toHaveLength(1);
    expect(cancelled.json().promoted[0].id).toBe(waitlisted.json().booking.id);
    void seeded;

    const queue = await app.inject({ method: 'GET', url: `/api/classes/${klass.id}/waitlist` });
    expect(queue.json().waitlisted).toBe(0);
  });

  it('rejects a double booking with 409', async () => {
    const seeded = await seedMembers(h, 1, () => ({}), { prefix: 'dbl' });
    const klass = await h.repo.table('classes').insert({
      id: 'cls_dbl',
      studioId: 'std_demo',
      name: 'Double',
      instructorId: 'ins_001',
      startTime: h.at(1, 9).toISOString(),
      capacity: 5,
      status: 'scheduled',
    });
    await app.inject({ ...json({ memberId: 'dbl_001', classId: klass.id }), url: '/api/bookings' });
    const second = await app.inject({
      ...json({ memberId: 'dbl_001', classId: klass.id }),
      url: '/api/bookings',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toMatch(/already booked/);
    void seeded;
  });

  it('books in bulk and reports failures', async () => {
    const seeded = await seedMembers(h, 3, () => ({}), { prefix: 'bulk' });
    const klass = await h.repo.table('classes').insert({
      id: 'cls_bulk',
      studioId: 'std_demo',
      name: 'Bulk',
      instructorId: 'ins_001',
      startTime: h.at(1, 9).toISOString(),
      capacity: 5,
      status: 'scheduled',
    });
    await h.repo.table('members').update('bulk_002', { status: 'cancelled' });
    const res = await app.inject({
      ...json({
        memberIds: ['bulk_001', 'bulk_002', 'bulk_003'],
        classId: klass.id,
      }),
      url: '/api/bookings/bulk',
    });
    expect(res.json().booked).toHaveLength(2);
    expect(res.json().failed).toHaveLength(1);
    void seeded;
  });
});

describe('check-in', () => {
  it('issues a QR ticket and validates it', async () => {
    await seedMembers(h, 1, () => ({}), { prefix: 'qr' });
    const res = await app.inject({ method: 'GET', url: '/api/members/qr_001/checkin-ticket' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ticket.code).toMatch(/^sd1\./);
    expect(body.valid).toBe(true);
  });

  it('checks a member in and reports a duplicate', async () => {
    await seedMembers(h, 1, () => ({}), { prefix: 'scan' });
    const klass = await h.repo.table('classes').insert({
      id: 'cls_scan',
      studioId: 'std_demo',
      name: 'Scanned',
      instructorId: 'ins_001',
      startTime: h.at(0, 9).toISOString(),
      capacity: 10,
      status: 'scheduled',
    });
    await h.repo.table('bookings').insert({
      id: 'bkg_scan',
      memberId: 'scan_001',
      classId: klass.id,
      status: 'booked',
    });

    const first = await app.inject({
      ...json({ memberId: 'scan_001', classId: klass.id, method: 'manual' }),
      url: '/api/checkin',
    });
    expect(first.json().status).toBe('checked-in');

    const second = await app.inject({
      ...json({ memberId: 'scan_001', classId: klass.id, method: 'manual' }),
      url: '/api/checkin',
    });
    expect(second.json().status).toBe('duplicate');
  });

  it('refuses a check-in from outside the geofence', async () => {
    await seedMembers(h, 1, () => ({}), { prefix: 'far' });
    const res = await app.inject({
      ...json({
        memberId: 'far_001',
        method: 'geo',
        latitude: 52.4862,
        longitude: -1.8904,
      }),
      url: '/api/checkin',
    });
    expect(res.json().status).toBe('outside-geofence');
  });

  it('400s a malformed check-in', async () => {
    const res = await app.inject({ ...json({ method: 'manual' }), url: '/api/checkin' });
    expect(res.statusCode).toBe(400);
  });
});

describe('reports', () => {
  it('serves revenue, attendance and churn', async () => {
    const revenue = await app.inject({ method: 'GET', url: '/api/reports/revenue?days=30' });
    expect(revenue.statusCode).toBe(200);
    expect(revenue.json().grossCents).toBe(0);

    const attendance = await app.inject({ method: 'GET', url: '/api/reports/attendance?days=30' });
    expect(attendance.statusCode).toBe(200);
    expect(attendance.json().attendanceRate).toBe(0);

    // `enrich=false` keeps it deterministic without a Groq key.
    const churn = await app.inject({ method: 'GET', url: '/api/reports/churn?enrich=false' });
    expect(churn.statusCode).toBe(200);
    expect(churn.json().activeMembers).toBeGreaterThanOrEqual(0);
    expect(churn.json().insights.length).toBeGreaterThan(0);
  });

  it('serves the dashboard and health check', async () => {
    const dash = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(dash.statusCode).toBe(200);
    expect(dash.json().studio.name).toBe('Riverbend Yoga');

    const health = await app.inject({ method: 'GET', url: '/api/health-check' });
    expect(health.statusCode).toBe(200);
    expect(health.json().score).toBeGreaterThanOrEqual(0);
  });

  it('scores a single member', async () => {
    await seedMembers(h, 1, () => ({}), { prefix: 'score' });
    const res = await app.inject({ method: 'GET', url: '/api/reports/churn/score_001' });
    expect(res.statusCode).toBe(200);
    expect(res.json().risk).toBeGreaterThanOrEqual(0);
  });
});

describe('billing routes', () => {
  it('subscribes a member offline', async () => {
    const seeded = await seedMembers(h, 1, () => ({}), { prefix: 'sub' });
    const res = await app.inject({
      ...json({ memberId: 'sub_001', planId: 'plan_unlimited', gateway: 'manual' }),
      url: '/api/billing/subscribe',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('active');
    void seeded;
  });

  it('sells a class pack', async () => {
    await seedMembers(h, 1, () => ({}), { prefix: 'pack' });
    const res = await app.inject({
      ...json({ memberId: 'pack_001', packName: '10 Class Pack' }),
      url: '/api/billing/packs',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pack.credits).toBe(10);
  });

  it('sells a drop-in', async () => {
    await seedMembers(h, 1, () => ({}), { prefix: 'drop' });
    const klass = await h.repo.table('classes').insert({
      id: 'cls_drop',
      studioId: 'std_demo',
      name: 'Drop-in Class',
      instructorId: 'ins_001',
      startTime: h.at(1, 9).toISOString(),
      capacity: 10,
      status: 'scheduled',
    });
    const res = await app.inject({
      ...json({ memberId: 'drop_001', classId: klass.id }),
      url: '/api/billing/drop-ins',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amountCents).toBe(2200);
  });

  it('runs dunning and renewals without error', async () => {
    expect((await app.inject({ ...json({}), url: '/api/billing/dunning/run' })).statusCode).toBe(200);
    expect((await app.inject({ ...json({}), url: '/api/billing/renew' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/billing/dunning' })).statusCode).toBe(200);
  });
});

describe('notifications', () => {
  it('queues a notification on booking', async () => {
    await seedMembers(h, 1, () => ({}), { prefix: 'note' });
    const klass = await h.repo.table('classes').insert({
      id: 'cls_note',
      studioId: 'std_demo',
      name: 'Notified',
      instructorId: 'ins_001',
      startTime: h.at(1, 9).toISOString(),
      capacity: 10,
      status: 'scheduled',
    });
    await app.inject({ ...json({ memberId: 'note_001', classId: klass.id }), url: '/api/bookings' });

    const res = await app.inject({ method: 'GET', url: '/api/notifications?memberId=note_001' });
    expect(res.json().length).toBeGreaterThan(0);
    expect(res.json()[0].kind).toBe('booking-confirmed');
  });
});

describe('with the demo seed', () => {
  it('serves a fully populated dashboard', async () => {
    // The seeded studio (100 members) replaces the test fixture.
    const seededCtx = createContext({ repo: h.repo, events: h.events, now: h.now });
    await seedDemoStudio(seededCtx, { members: 100 });

    const { createStudioDesk } = await import('@studiodesk/core');
    const desk = await createStudioDesk({ repo: h.repo, events: h.events, now: h.now });
    const seededApp = await buildServer({ desk, logger: false });

    const members = await seededApp.inject({ method: 'GET', url: '/api/members?limit=5' });
    expect(members.json().total).toBeGreaterThanOrEqual(100);

    const dashboard = await seededApp.inject({ method: 'GET', url: '/api/dashboard' });
    expect(dashboard.json().activeMembers).toBeGreaterThan(50);
    expect(dashboard.json().mrrCents).toBeGreaterThan(0);

    const revenue = await seededApp.inject({ method: 'GET', url: '/api/reports/revenue?days=60' });
    expect(revenue.json().transactions).toBeGreaterThan(0);

    const attendance = await seededApp.inject({ method: 'GET', url: '/api/reports/attendance?days=60' });
    expect(attendance.json().attended).toBeGreaterThan(0);

    await seededApp.close();
  });
});