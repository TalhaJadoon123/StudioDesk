/**
 * Cloudflare Workers entrypoint.
 *
 * Fastify cannot run on Workers (it needs Node's HTTP stack), so this module
 * re-implements the same route table on the Workers runtime using the Workers
 * `fetch` handler. It shares every rule with the Node server because both call
 * the same `@studiodesk/*` service functions - only the transport differs.
 *
 * Data lives in Supabase (see `createSupabaseRepository`); Workers have no
 * filesystem, so the in-memory driver is only used when Supabase is absent.
 *
 *   npx wrangler deploy -f packages/api/wrangler.toml
 */

import { toErrorBody, config } from '@studiodesk/shared';
import { createStudioDesk } from '@studiodesk/core';
import { connectBilling } from '@studiodesk/billing';
import { checkin } from '@studiodesk/checkin';
import { buildCalendar, buildWeekGrid } from '@studiodesk/booking';

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  GROQ_API_KEY?: string;
  CHECKIN_SIGNING_SECRET?: string;
  /** Explicit allowlist. `*` disables credentialed cross-origin access. */
  ALLOWED_ORIGIN?: string;
  /** When set, every non-health route requires this bearer token. */
  API_KEY?: string;
  POLAR_ACCESS_TOKEN?: string;
  STRIPE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
}

/** One promise per isolate - Workers reuses the isolate across requests. */
let deskPromise: ReturnType<typeof createStudioDesk> | undefined;

async function getDesk(env: Env) {
  if (!deskPromise) {
    deskPromise = (async () => {
      const desk = await createStudioDesk();
      connectBilling(desk.ctx);
      return desk;
    })();
  }
  return deskPromise;
}

type Handler = (request: Request, params: Record<string, string>, url: URL) => Promise<Response>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Minimal path router: `['POST', '/api/bookings/:id'] -> handler`. */
const routes: Array<[string, string, Handler]> = [];

function on(method: string, pattern: string, handler: Handler): void {
  routes.push([method, pattern, handler]);
}

function match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      const expected = patternParts[i]!;
      const actual = pathParts[i]!;
      if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
      else if (expected !== actual) {
        matches = false;
        break;
      }
    }
    if (matches) return { handler, params };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/** Readiness probe for the Workers deploy gate. */
on('GET', '/ready', async () => {
  const desk = await getDesk({} as Env);
  try {
    await desk.ctx.repo.table('studios').count();
    return json({ ready: true, driver: desk.ctx.repo.kind });
  } catch (error) {
    return json({
      ready: false,
      driver: desk.ctx.repo.kind,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
});

on('GET', '/api/dashboard', async (_request, _params, _url) => {
  const desk = await getDesk({} as Env);
  return json(await desk.reports.dashboardSnapshot(desk.ctx));
});

on('GET', '/api/health-check', async () => {
  const desk = await getDesk({} as Env);
  return json(await desk.reports.studioHealthCheck(desk.ctx));
});

on('GET', '/api/studio', async () => {
  const desk = await getDesk({} as Env);
  const studio = await desk.studio.getStudio(desk.ctx);
  const plan = await desk.studio.getStudioPlan(desk.ctx);
  return json({ studio, tier: plan.tier, limits: plan.limits });
});

on('GET', '/api/members', async (_request, _params, url) => {
  const desk = await getDesk({} as Env);
  const search = url.searchParams.get('search') ?? undefined;
  const status = (url.searchParams.get('status') as never) ?? undefined;
  const page = await desk.members.listMembersPaginated(desk.ctx, {
    search,
    status,
    limit: Number(url.searchParams.get('limit') ?? 100),
  });
  return json(page);
});

on('POST', '/api/members', async (request) => {
  const desk = await getDesk({} as Env);
  const payload = await body(request);
  const member = await desk.members.createMember(desk.ctx, payload as never);
  return json(member, 201);
});

on('GET', '/api/members/:id', async (_request, params) => {
  const desk = await getDesk({} as Env);
  return json(await desk.members.getMemberDetail(desk.ctx, params.id!));
});

on('PATCH', '/api/members/:id', async (request, params) => {
  const desk = await getDesk({} as Env);
  const payload = await body(request);
  return json(await desk.members.updateMember(desk.ctx, params.id!, payload as never));
});

on('GET', '/api/classes', async (_request, _params, url) => {
  const desk = await getDesk({} as Env);
  return json(
    await desk.classes.listClassesWithCounts(desk.ctx, {
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      instructorId: url.searchParams.get('instructorId') ?? undefined,
    }),
  );
});

on('POST', '/api/classes', async (request) => {
  const desk = await getDesk({} as Env);
  const payload = await body(request);
  return json(await desk.classes.createClass(desk.ctx, payload as never), 201);
});

on('POST', '/api/bookings', async (request) => {
  const desk = await getDesk({} as Env);
  const payload = await body(request);
  const result = await desk.bookings.createBooking(desk.ctx, payload as never);
  return json(result, 201);
});

on('DELETE', '/api/bookings/:id', async (request, params) => {
  const desk = await getDesk({} as Env);
  const payload = await body(request);
  return json(await desk.bookings.cancelBooking(desk.ctx, params.id!, payload as never));
});

on('POST', '/api/checkin', async (request) => {
  const desk = await getDesk({} as Env);
  const payload = await body(request);
  const point =
    typeof payload.latitude === 'number' && typeof payload.longitude === 'number'
      ? { latitude: payload.latitude, longitude: payload.longitude }
      : undefined;
  return json(
    await checkin(desk.ctx, {
      memberId: payload.memberId as string | undefined,
      classId: payload.classId as string | undefined,
      code: payload.code as string | undefined,
      method: (payload.method as never) ?? 'manual',
      point,
    }),
  );
});

on('GET', '/api/schedule', async (_request, _params, url) => {
  const desk = await getDesk({} as Env);
  const anchor = url.searchParams.get('anchor') ?? undefined;
  const instructorId = url.searchParams.get('instructorId') ?? undefined;
  if (url.searchParams.get('view') === 'week') {
    return json(await buildWeekGrid(desk.ctx, anchor ?? desk.ctx.now(), { instructorId }));
  }
  const now = desk.ctx.now();
  return json(
    await buildCalendar(desk.ctx, {
      from: url.searchParams.get('from') ?? new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      to: url.searchParams.get('to') ?? new Date(now.getTime() + 21 * 86_400_000).toISOString(),
      instructorId,
    }),
  );
});

on('GET', '/api/reports/revenue', async (_request, _params, url) => {
  const desk = await getDesk({} as Env);
  return json(
    await desk.reports.revenueReport(desk.ctx, {
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      days: Number(url.searchParams.get('days') ?? 30),
    }),
  );
});

on('GET', '/api/reports/attendance', async (_request, _params, url) => {
  const desk = await getDesk({} as Env);
  return json(
    await desk.reports.attendanceReport(desk.ctx, {
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
    }),
  );
});

on('GET', '/api/reports/churn', async (_request, _params, url) => {
  const desk = await getDesk({} as Env);
  return json(await desk.churn.churnReport(desk.ctx, { from: url.searchParams.get('from') ?? undefined }));
});

/* -------------------------------------------------------------------------- */
/* Worker entrypoint                                                          */
/* -------------------------------------------------------------------------- */

/** Health probes must stay unauthenticated, or Workers deploys never go live. */
const PUBLIC_PATHS = new Set(['/health', '/ready', '/']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const configured = env.ALLOWED_ORIGIN ?? '*';
    // Never pair a wildcard origin with credentials.
    const allowOrigin = configured === '*' ? '*' : configured;

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key,X-Studio-Id',
      'Access-Control-Max-Age': '86400',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    };
    if (allowOrigin !== '*') corsHeaders['Access-Control-Allow-Credentials'] = 'true';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Origin': allowOrigin } });
    }

    const withHeaders = (response: Response): Response => {
      response.headers.set('Access-Control-Allow-Origin', allowOrigin);
      if (allowOrigin !== '*') response.headers.set('Vary', 'Origin');
      for (const [key, value] of Object.entries(corsHeaders)) {
        if (key === 'Access-Control-Allow-Origin') continue;
        response.headers.set(key, value);
      }
      return response;
    };

    const path = url.pathname;

    // Handled here rather than in the router because it reports on `env`.
    if (path === '/health') {
      return withHeaders(
        json({
          status: 'ok',
          service: 'studiodesk-worker',
          runtime: 'cloudflare-workers',
          live: true,
          security: {
            authRequired: Boolean(env.API_KEY),
            corsWildcard: allowOrigin === '*',
            rateLimit: 'per-isolate (no shared counter)',
          },
          integrations: { supabase: config.hasHostedBackend(), groq: config.hasAi() },
        }),
      );
    }

    // Bearer-token gate when a key is configured.
    if (env.API_KEY && !PUBLIC_PATHS.has(path)) {
      const header = request.headers.get('authorization') ?? '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const viaHeader = request.headers.get('x-api-key') ?? '';
      const expected = env.API_KEY!;
      const ok = (candidate: string): boolean => {
        if (candidate.length !== expected.length) return false;
        let diff = 0;
        for (let i = 0; i < candidate.length; i += 1) {
          diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
        }
        return diff === 0;
      };
      if (!ok(supplied) && !ok(viaHeader)) {
        return withHeaders(
          json({ error: 'unauthorized', message: 'Missing or invalid API key.' }, 401),
        );
      }
    }

    const matched = match(request.method, path);
    if (!matched) {
      return withHeaders(json({ error: 'not_found', message: `No route for ${path}` }, 404));
    }

    try {
      const response = await matched.handler(request, matched.params, url);
      return withHeaders(response);
    } catch (error) {
      const { statusCode, body: payload } = toErrorBody(error);
      return withHeaders(json(payload, statusCode));
    }
  },
};