import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  config,
  toErrorBody,
  type DashboardSnapshot,
  type GatewayName,
} from '@studiodesk/shared';
import {
  createStudioDesk,
  type CreateStudioDeskOptions,
  type StudioDesk,
} from '@studiodesk/core';
import { parseOrThrow } from '@studiodesk/core';
import { connectBilling } from '@studiodesk/billing';
import {
  dunningSummary,
  dropIns,
  fees,
  invoiceToPdf,
  invoices,
  memberships,
  packs,
  renewDueMemberships,
  runDunning,
} from '@studiodesk/billing';
import {
  checkinSchema,
  classQuerySchema,
  createBookingSchema,
  createClassSchema,
  createInstructorSchema,
  createMemberSchema,
  createPlanSchema,
  dropInSchema,
  memberQuerySchema,
  parseOrNull,
  purchaseSchema,
  reportQuerySchema,
  subscriptionSchema,
  updateClassSchema,
  updateInstructorSchema,
  updateMemberSchema,
} from '@studiodesk/core';
import {
  buildCalendar,
  buildWeekGrid,
  classWaitlist,
  promoteAndNotify,
  previewSeries,
  createSeries,
  expandOccurrences,
  parseRRule,
} from '@studiodesk/booking';
import { checkin, issueTicket, kioskCheckin, kioskLanding, verifyTicket } from '@studiodesk/checkin';

/**
 * StudioDesk HTTP API.
 *
 * Every route is a thin, typed wrapper over the same service functions the web
 * app and the mobile app call directly, so there is exactly one implementation
 * of every rule.
 */

/**
 * Resolves the CORS allowlist.
 *
 * Precedence: explicit option > `CORS_ORIGIN` > `ALLOWED_ORIGIN` > the web URL.
 * A comma-separated list is accepted. `*` is allowed only outside production,
 * and production refuses to boot with it.
 */
function resolveCorsOrigin(option?: string | string[] | true): string | string[] | true {
  if (option !== undefined) return option;

  const raw = process.env.CORS_ORIGIN ?? process.env.ALLOWED_ORIGIN;
  if (raw) {
    const list = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (list.includes('*')) return '*';
    if (list.length === 1) return list[0]!;
    if (list.length > 1) return list;
  }
  return config.webUrl();
}

export interface BuildServerOptions extends CreateStudioDeskOptions {
  desk?: StudioDesk;
  logger?: boolean;
  corsOrigin?: string | string[] | true;
  /**
   * Shared secret required on every `/api/*` request.
   *
   * With no key configured the server runs fully open - correct for local demo
   * mode and nothing else. `requireAuth` reports that state through
   * `/api/health` so a production deploy cannot silently run unauthenticated.
   */
  apiKey?: string;
  /** Max requests per IP per window. Set to 0 to disable. */
  rateLimit?: { max: number; windowMs: number };
}

declare module 'fastify' {
  interface FastifyRequest {
    desk: StudioDesk;
  }
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function ok<T>(reply: FastifyReply, payload: T, status = 200): FastifyReply {
  return reply.code(status).send(payload);
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? (config.nodeEnv() !== 'test'),
    bodyLimit: 1_048_576,
  });

  const desk = options.desk ?? (await createStudioDesk(options));
  // Wire fee assessment + notifications to domain events.
  const billing = connectBilling(desk.ctx);

  const origin = resolveCorsOrigin(options.corsOrigin);
  const apiKey = options.apiKey ?? process.env.API_KEY;
  const isProduction = config.nodeEnv() === 'production';

  // Never accept a credential check against an empty key: that would make an
  // unset API_KEY behave like `Bearer ''`.
  const effectiveApiKey = apiKey?.trim() ? apiKey : undefined;

  // Fail fast: an open API in production is a release blocker, not a warning.
  if (isProduction && !apiKey) {
    throw new Error(
      'API_KEY must be set in production. Refusing to start an unauthenticated API.',
    );
  }
  if (isProduction && (origin === true || origin === '*')) {
    throw new Error('CORS origin must be an explicit allowlist in production, not "*".');
  }

  // Hand-rolled CORS rather than @fastify/cors: it is ~20 lines, removes a
  // plugin whose major versions are pinned to specific Fastify releases, and
  // behaves identically on Node and Workers.
  app.addHook('onRequest', async (request, reply) => {
    const requestOrigin = request.headers.origin;
    const allowOrigin = origin === true || origin === '*' ? '*' : Array.isArray(origin) ? origin : [origin];
    const allowed =
      origin === true || origin === '*'
        ? '*'
        : requestOrigin && allowOrigin.includes(requestOrigin)
          ? requestOrigin
          : allowOrigin[0];

    // `*` and `Access-Control-Allow-Credentials: true` together are rejected by
    // browsers and signal a misconfiguration, so never emit the pair. In demo
    // mode the wildcard is fine and credentials are simply not offered.
    const wildcard = allowed === '*';
    reply.header('Access-Control-Allow-Origin', allowed);
    if (!wildcard) {
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Credentials', 'true');
    }
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Studio-Id');
    reply.header('Access-Control-Max-Age', '86400');

    if (request.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  // Baseline hardening headers.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-DNS-Prefetch-Control', 'off');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.removeHeader('X-Powered-By');
  });

  /**
   * In-memory fixed-window rate limiter.
   *
   * Sufficient for a single-instance studio deployment; swap for a shared store
   * (Redis/Workers KV) when running more than one replica.
   */
  const rateLimit = options.rateLimit ?? { max: 300, windowMs: 60_000 };
  const buckets = new Map<string, { count: number; resetAt: number }>();

  app.addHook('onRequest', async (request, reply) => {
    if (rateLimit.max <= 0) return;
    if (!request.url.startsWith('/api/')) return;

    const nowMs = Date.now();
    const key = request.ip ?? 'unknown';
    const existing = buckets.get(key);
    const resetAt = existing && existing.resetAt > nowMs ? existing.resetAt : nowMs + rateLimit.windowMs;
    const count = existing && existing.resetAt > nowMs ? existing.count + 1 : 1;

    buckets.set(key, { count, resetAt });

    // Always advertise the budget, even on the request that opens the window.
    reply.header('X-RateLimit-Limit', String(rateLimit.max));
    reply.header('X-RateLimit-Remaining', String(Math.max(0, rateLimit.max - count)));
    reply.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

    // Opportunistic cleanup so the map cannot grow unbounded.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= nowMs) buckets.delete(k);
    }

    if (count > rateLimit.max) {
      reply.header('Retry-After', String(Math.ceil((resetAt - nowMs) / 1000)));
      await reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many requests. Slow down.',
      });
    }
  });

  /** Bearer-token gate on every `/api/*` route, plus the public ones. */
  // Health probes must stay reachable without credentials, or an orchestrator
  // cannot poll them.
  const PUBLIC_PATHS = new Set(['/health', '/ready', '/', '/api/health']);

  app.addHook('onRequest', async (request, reply) => {
    if (!effectiveApiKey) return; // demo mode: open by design
    if (PUBLIC_PATHS.has(request.url.split('?')[0]!)) return;

    const header = request.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const provided = typeof request.headers['x-api-key'] === 'string'
      ? (request.headers['x-api-key'] as string)
      : '';

    const expected = effectiveApiKey;
    const matches = (candidate: string): boolean => {
      // Length is not secret; early-exit on mismatch is fine.
      if (candidate.length !== expected.length) return false;
      let diff = 0;
      for (let i = 0; i < candidate.length; i += 1) {
        diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      return diff === 0;
    };

    if (!matches(supplied) && !matches(provided)) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid API key.' });
    }
  });

  app.decorate('desk', desk);
  app.addHook('onClose', async () => {
    billing.fees.dispose();
    await desk.dispose();
  });

  // ---- error handling ---------------------------------------------------
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toErrorBody(error);
    if (statusCode >= 500) app.log.error({ err: error }, 'request failed');
    reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });

  /**
   * Wraps a handler so thrown AppErrors become proper status codes. A handler
   * may send its own reply (status/content-type); `reply.sent` tells us to
   * leave it alone.
   */
  const route =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>): Handler =>
    async (request, reply) => {
      try {
        const result = await handler(request, reply);
        if (reply.sent) return reply;
        return reply.code(200).send(result);
      } catch (error) {
        const { statusCode, body } = toErrorBody(error);
        if (statusCode >= 500) app.log.error({ err: error }, 'handler failed');
        return reply.code(statusCode).send(body);
      }
    };

  /* ====================================================================== */
  /* Health & meta                                                          */
  /* ====================================================================== */

  app.get('/health', route(async () => ({
    status: 'ok',
    service: 'studiodesk-api',
    driver: desk.ctx.repo.kind,
    /** Liveness: the process is up and the event loop is turning. */
    live: true,
    integrations: {
      supabase: config.hasHostedBackend(),
      groq: config.hasAi(),
      payments: config.hasPayments(),
      email: Boolean(config.resendApiKey() || config.useSendUrl()),
    },
    security: {
      authRequired: Boolean(effectiveApiKey),
      corsWildcard: origin === true || origin === '*',
      rateLimit: rateLimit.max > 0 ? `${rateLimit.max}/${rateLimit.windowMs}ms` : 'disabled',
    },
    uptimeSeconds: Math.round(process.uptime()),
  })));

  /** Readiness: the data layer answers. Use this as the deploy gate. */
  app.get('/ready', route(async () => {
    try {
      await desk.ctx.repo.table('studios').count();
      return { ready: true, driver: desk.ctx.repo.kind };
    } catch (error) {
      return {
        ready: false,
        driver: desk.ctx.repo.kind,
        reason: error instanceof Error ? error.message : 'unknown',
      };
    }
  }));

  app.get('/', route(async () => ({
    name: 'StudioDesk API',
    version: '1.0.0',
    docs: '/docs',
    endpoints: [
      'GET  /health',
      'GET  /api/studio',
      'GET  /api/health-check',
      'GET  /api/dashboard',
      'CRUD /api/members',
      'CRUD /api/plans',
      'CRUD /api/instructors',
      'CRUD /api/classes',
      'GET  /api/schedule',
      'POST /api/bookings',
      'DELETE /api/bookings/:id',
      'POST /api/checkin',
      'POST /api/billing/subscribe',
      'GET  /api/reports/attendance|revenue|churn',
    ],
  })));

  /* ====================================================================== */
  /* Studio                                                                 */
  /* ====================================================================== */

  app.get('/api/studio', route(async () => {
    const studio = await desk.studio.getStudio(desk.ctx);
    const plan = await desk.studio.getStudioPlan(desk.ctx);
    return { studio, plan: { tier: plan.tier, name: plan.name, limits: plan.limits } };
  }));

  app.get('/api/health-check', route(async () => desk.reports.studioHealthCheck(desk.ctx)));

  app.get('/api/dashboard', route(async (): Promise<DashboardSnapshot> => desk.reports.dashboardSnapshot(desk.ctx)));

  /* ====================================================================== */
  /* Members                                                                */
  /* ====================================================================== */

  app.get('/api/members', route(async (request) => {
    const query = parseOrThrow(memberQuerySchema, request.query ?? {}, 'Invalid member query');
    await desk.members.reconcilePauses(desk.ctx);
    const page = await desk.members.listMembersPaginated(desk.ctx, query);
    return page;
  }));

  app.post('/api/members', route(async (request) => {
    const body = parseOrThrow(createMemberSchema, request.body, 'Invalid member payload');
    return desk.members.createMember(desk.ctx, body);
  }));

  app.get('/api/members/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    return desk.members.getMemberDetail(desk.ctx, id);
  }));

  app.patch('/api/members/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateMemberSchema, request.body, 'Invalid member payload');
    return desk.members.updateMember(desk.ctx, id, body);
  }));

  app.delete('/api/members/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    return { deleted: await desk.members.deleteMember(desk.ctx, id) };
  }));

  app.post('/api/members/:id/pause', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { days?: number };
    return desk.members.pauseMember(desk.ctx, id, body.days ?? 30);
  }));

  app.post('/api/members/:id/resume', route(async (request) => {
    const { id } = request.params as { id: string };
    return desk.members.resumeMember(desk.ctx, id);
  }));

  app.post('/api/members/:id/cancel', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string };
    return desk.members.cancelMember(desk.ctx, id, body.reason);
  }));

  app.get('/api/members/:id/usage', route(async (request) => {
    const { id } = request.params as { id: string };
    return desk.members.memberUsage(desk.ctx, id);
  }));

  /* ====================================================================== */
  /* Plans                                                                  */
  /* ====================================================================== */

  app.get('/api/plans', route(async () => desk.plans.listPlans(desk.ctx)));

  app.post('/api/plans', route(async (request) => {
    const body = parseOrThrow(createPlanSchema, request.body, 'Invalid plan payload');
    return desk.plans.createPlan(desk.ctx, body);
  }));

  app.patch('/api/plans/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return desk.plans.updatePlan(desk.ctx, id, body);
  }));

  app.delete('/api/plans/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    return { deleted: await desk.plans.deletePlan(desk.ctx, id) };
  }));

  /* ====================================================================== */
  /* Instructors                                                            */
  /* ====================================================================== */

  app.get('/api/instructors', route(async () => desk.classes.listInstructors(desk.ctx)));

  app.post('/api/instructors', route(async (request) => {
    const body = parseOrThrow(createInstructorSchema, request.body, 'Invalid instructor payload');
    return desk.classes.createInstructor(desk.ctx, body);
  }));

  app.patch('/api/instructors/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateInstructorSchema, request.body, 'Invalid instructor payload');
    return desk.classes.updateInstructor(desk.ctx, id, body);
  }));

  app.delete('/api/instructors/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    return { deleted: await desk.classes.deleteInstructor(desk.ctx, id) };
  }));

  app.get('/api/instructors/:id/load', route(async (request) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { days?: string };
    const { instructorLoad } = await import('@studiodesk/booking');
    const from = new Date(desk.ctx.now().getTime() - 30 * 86_400_000).toISOString();
    const to = new Date(desk.ctx.now().getTime() + (query.days ? Number(query.days) : 30) * 86_400_000).toISOString();
    return instructorLoad(desk.ctx, id, { from, to });
  }));

  /* ====================================================================== */
  /* Classes & schedule                                                    */
  /* ====================================================================== */

  app.get('/api/classes', route(async (request) => {
    const query = parseOrThrow(classQuerySchema, request.query ?? {}, 'Invalid class query');
    return desk.classes.listClassesWithCounts(desk.ctx, query);
  }));

  app.post('/api/classes', route(async (request) => {
    const body = parseOrThrow(createClassSchema, request.body, 'Invalid class payload');
    return desk.classes.createClass(desk.ctx, body);
  }));

  app.patch('/api/classes/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateClassSchema, request.body, 'Invalid class payload');
    return desk.classes.updateClass(desk.ctx, id, body);
  }));

  app.delete('/api/classes/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    return { deleted: await desk.classes.deleteClass(desk.ctx, id) };
  }));

  app.post('/api/classes/:id/cancel', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string };
    return desk.classes.cancelClass(desk.ctx, id, body.reason ?? 'Cancelled by the studio');
  }));

  app.post('/api/classes/:id/complete', route(async (request) => {
    const { id } = request.params as { id: string };
    return desk.bookings.finalizeClass(desk.ctx, id);
  }));

  app.get('/api/classes/:id/roster', route(async (request) => {
    const { id } = request.params as { id: string };
    const { classRosterForCheckin } = await import('@studiodesk/checkin');
    const [roster, capacity] = await Promise.all([
      classRosterForCheckin(desk.ctx, id),
      desk.bookings.classCapacity(desk.ctx, id),
    ]);
    return { ...roster, capacity };
  }));

  app.get('/api/schedule', route(async (request) => {
    const query = (request.query ?? {}) as {
      from?: string;
      to?: string;
      instructorId?: string;
      classType?: string;
      view?: 'week' | 'month';
      anchor?: string;
    };
    const now = desk.ctx.now();
    const anchor = query.anchor ?? now.toISOString();
    if (query.view === 'week') return buildWeekGrid(desk.ctx, anchor, { instructorId: query.instructorId, classType: query.classType });
    if (query.view === 'month') {
      const { buildMonthGrid } = await import('@studiodesk/booking');
      return buildMonthGrid(desk.ctx, anchor, { instructorId: query.instructorId, classType: query.classType });
    }
    const from = query.from ?? new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const to = query.to ?? new Date(now.getTime() + 21 * 86_400_000).toISOString();
    return buildCalendar(desk.ctx, { from, to, instructorId: query.instructorId, classType: query.classType });
  }));

  /* ====================================================================== */
  /* Recurring series                                                       */
  /* ====================================================================== */

  app.post('/api/schedule/series/preview', route(async (request) => {
    const body = request.body as {
      rrule: string;
      instructorId: string;
      durationMinutes: number;
      from?: string;
      to?: string;
    };
    return previewSeries(desk.ctx, body);
  }));

  app.post('/api/schedule/series', route(async (request) => {
    const body = request.body as {
      rrule: string;
      name: string;
      instructorId: string;
      durationMinutes: number;
      capacity: number;
      from: string;
      to?: string;
      room?: string;
      color?: string;
      classType?: string;
    };
    return createSeries(desk.ctx, body);
  }));

  app.post('/api/schedule/rrule/expand', route(async (request) => {
    const body = request.body as { rrule: string; from?: string; to?: string; durationMinutes?: number };
    const { describeRRule } = await import('@studiodesk/booking');
    const occurrences = expandOccurrences(body.rrule, {
      from: body.from ?? desk.ctx.now().toISOString(),
      to: body.to,
      durationMinutes: body.durationMinutes ?? 60,
      limit: 120,
    });
    return {
      rrule: body.rrule,
      description: describeRRule(body.rrule),
      parsed: parseRRule(body.rrule),
      occurrences,
    };
  }));

  /* ====================================================================== */
  /* Bookings                                                               */
  /* ====================================================================== */

  app.post('/api/bookings', route(async (request) => {
    const body = parseOrThrow(createBookingSchema, request.body, 'Invalid booking payload');
    const result = await desk.bookings.createBooking(desk.ctx, body);
    return result;
  }));

  app.post('/api/bookings/bulk', route(async (request) => {
    const body = request.body as { memberIds: string[]; classId: string; source?: 'staff' | 'kiosk' };
    return desk.bookings.createBookings(
      desk.ctx,
      body.memberIds.map((memberId) => ({ memberId, classId: body.classId, source: body.source ?? 'staff' })),
    );
  }));

  app.get('/api/bookings', route(async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    return desk.bookings.listBookingsWithContext(desk.ctx, {
      memberId: query.memberId,
      classId: query.classId,
      status: query.status as never,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  }));

  app.get('/api/bookings/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    const booking = await desk.bookings.requireBooking(desk.ctx, id);
    const member = await desk.ctx.repo.table('members').findById(booking.memberId);
    const klass = await desk.ctx.repo.table('classes').findById(booking.classId);
    return { booking, member, class: klass };
  }));

  app.delete('/api/bookings/:id', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string; waived?: boolean; byStaff?: boolean };
    return desk.bookings.cancelBooking(desk.ctx, id, body);
  }));

  app.get('/api/classes/:id/waitlist', route(async (request) => {
    const { id } = request.params as { id: string };
    return classWaitlist(desk.ctx, id);
  }));

  app.post('/api/classes/:id/waitlist/promote', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { slots?: number };
    return promoteAndNotify(desk.ctx, id, body.slots);
  }));

  /* ====================================================================== */
  /* Check-in                                                               */
  /* ====================================================================== */

  app.post('/api/checkin', route(async (request, reply) => {
    const body = parseOrThrow(checkinSchema, request.body, 'Invalid check-in payload');
    const result = await checkin(desk.ctx, {
      memberId: body.memberId,
      bookingId: body.bookingId,
      classId: body.classId,
      code: body.code,
      method: body.method ?? (body.code ? 'qr' : 'manual'),
      point:
        body.latitude !== undefined && body.longitude !== undefined
          ? { latitude: body.latitude, longitude: body.longitude }
          : undefined,
      deviceId: body.deviceId,
      staffId: body.staffId,
      override: false,
    });
    // A rejected scan is a normal outcome, not a server error - 200 with a body
    // the scanner can render, except for malformed payloads.
    return reply.code(result.status === 'invalid' && !result.memberId ? 400 : 200).send(result);
  }));

  app.get('/api/members/:id/checkin-ticket', route(async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { format?: 'json' | 'png' | 'svg'; ttl?: string };
    const ticket = await issueTicket(id, {
      ttlSeconds: query.ttl ? Number(query.ttl) : undefined,
    });

    if (query.format === 'png') {
      const { ticketToDataUrl } = await import('@studiodesk/checkin');
      const dataUrl = await ticketToDataUrl(ticket.code);
      // Data URLs are returned as JSON so the app can render them directly.
      return reply.send({ ticket, dataUrl });
    }
    if (query.format === 'svg') {
      const { ticketToSvg } = await import('@studiodesk/checkin');
      const svg = await ticketToSvg(ticket.code);
      return reply.header('Content-Type', 'image/svg+xml').send(svg);
    }
    return { ticket, ...(await verifyTicket(ticket.code)) };
  }));

  app.post('/api/checkin/verify', route(async (request) => {
    const body = parseOrThrow(checkinSchema, request.body, 'Invalid check-in payload');
    return verifyTicket(body.code ?? '');
  }));

  app.get('/api/kiosk/:deviceId/landing', route(async (request) => {
    const { deviceId } = request.params as { deviceId: string };
    return kioskLanding(desk.ctx, deviceId);
  }));

  app.post('/api/kiosk/:deviceId/checkin', route(async (request) => {
    const { deviceId } = request.params as { deviceId: string };
    const body = parseOrThrow(checkinSchema, request.body, 'Invalid check-in payload');
    return kioskCheckin(desk.ctx, { deviceId, memberId: body.memberId ?? '', classId: body.classId });
  }));

  /* ====================================================================== */
  /* Billing                                                                */
  /* ====================================================================== */

  app.post('/api/billing/subscribe', route(async (request) => {
    const body = parseOrThrow(subscriptionSchema, request.body, 'Invalid subscription payload');
    return memberships.subscribe(desk.ctx, {
      memberId: body.memberId,
      planId: body.planId,
      chargeNow: body.chargeNow,
      trialDays: body.trialDays,
      gateway: body.gateway === 'manual' ? undefined : billing.gateways.byName[(body.gateway ?? billing.gateways.active) as GatewayName],
      offline: !billing.gateways.hasPayments,
    });
  }));

  app.post('/api/billing/memberships/:id/cancel', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { immediate?: boolean };
    return memberships.cancelMembership(desk.ctx, id, {
      immediate: body.immediate,
      gateway: billing.gateways.recurring,
    });
  }));

  app.post('/api/billing/packs', route(async (request) => {
    const body = parseOrThrow(purchaseSchema, request.body, 'Invalid pack purchase');
    return packs.purchasePack(desk.ctx, {
      memberId: body.memberId,
      packName: body.packName,
      credits: body.credits,
      priceCents: body.priceCents,
      currency: body.currency,
      idempotencyKey: body.idempotencyKey,
      gateway: billing.gateways.oneOff,
    });
  }));

  app.post('/api/billing/drop-ins', route(async (request) => {
    const body = parseOrThrow(dropInSchema, request.body, 'Invalid drop-in purchase');
    return dropIns.purchaseDropIn(desk.ctx, {
      memberId: body.memberId,
      classId: body.classId,
      priceCents: body.priceCents,
      idempotencyKey: body.idempotencyKey,
      gateway: billing.gateways.oneOff,
    });
  }));

  app.get('/api/billing/memberships', route(async (request) => {
    const query = (request.query ?? {}) as { memberId?: string };
    return memberships.listMemberships(desk.ctx, { memberId: query.memberId });
  }));

  app.post('/api/billing/dunning/run', route(async () => {
    return runDunning(desk.ctx, billing.gateways.recurring);
  }));

  app.get('/api/billing/dunning', route(async () => {
    return dunningSummary(desk.ctx);
  }));

  app.post('/api/billing/renew', route(async () => {
    return renewDueMemberships(desk.ctx, billing.gateways.recurring);
  }));

  app.post('/api/billing/fees/:id/waive', route(async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: 'studio-error' | 'instructor-cancel' | 'medical' | 'manager-override'; note?: string };
    return fees.waiveFee(desk.ctx, id, body.reason ?? 'manager-override', body.note);
  }));

  /* ====================================================================== */
  /* Reports                                                                */
  /* ====================================================================== */

  app.get('/api/reports/revenue', route(async (request) => {
    const query = parseOrThrow(reportQuerySchema, request.query ?? {}, 'Invalid report query');
    return desk.reports.revenueReport(desk.ctx, query);
  }));

  app.get('/api/reports/attendance', route(async (request) => {
    const query = parseOrThrow(reportQuerySchema, request.query ?? {}, 'Invalid report query');
    return desk.reports.attendanceReport(desk.ctx, query);
  }));

  app.get('/api/reports/churn', route(async (request) => {
    const query = parseOrOrThrow((request.query ?? {}) as Record<string, unknown>);
    return desk.churn.churnReport(desk.ctx, { from: query.from, to: query.to }, { enrich: query.enrich !== false });
  }));

  app.get('/api/reports/churn/:memberId', route(async (request) => {
    const { memberId } = request.params as { memberId: string };
    return desk.churn.scoreMember(desk.ctx, memberId);
  }));

  app.get('/api/reports/classes/:classId', route(async (request) => {
    const { classId } = request.params as { classId: string };
    const klass = await desk.classes.requireClass(desk.ctx, classId);
    return desk.attendance.classSummary(desk.ctx, klass);
  }));

  app.post('/api/invoices/:id/pdf', route(async (request, reply) => {
    const { id } = request.params as { id: string };
    const invoice = await invoices.requireInvoice(desk.ctx, id);
    const member = invoice.memberId ? await desk.ctx.repo.table('members').findById(invoice.memberId) : null;
    const studio = await desk.studio.getStudio(desk.ctx);
    const pdf = await invoiceToPdf({
      invoice,
      studioName: studio.name,
      memberName: member?.name,
      memberEmail: member?.email,
    });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${invoice.number}.pdf"`)
      .send(Buffer.from(pdf.base64, 'base64'));
  }));

  /* ====================================================================== */
  /* Notifications                                                          */
  /* ====================================================================== */

  app.get('/api/notifications', route(async (request) => {
    const query = (request.query ?? {}) as { memberId?: string; unread?: string };
    return desk.notifications.listNotifications(desk.ctx, {
      memberId: query.memberId,
      unreadOnly: query.unread === 'true',
    });
  }));

  app.post('/api/notifications/:id/read', route(async (request) => {
    const { id } = request.params as { id: string };
    return desk.notifications.markRead(desk.ctx, id);
  }));

  return app;
}

function parseOrOrThrow(query: Record<string, unknown>) {
  const parsed = parseOrNull(reportQuerySchema, query);
  return parsed ?? {};
}

export default buildServer;