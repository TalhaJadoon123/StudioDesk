import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createContext, createStudioDesk, type StudioDesk } from '@studiodesk/core';
import { harness, seedInstructor, seedPlan, seedStudio, type Harness } from '@studiodesk/core/test';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const API_KEY = 'test-api-key-0123456789abcdef';

/** Builds a server wired to a fresh fixture. */
async function makeServer(options: {
  apiKey?: string;
  corsOrigin?: string | string[] | true;
  rateLimit?: { max: number; windowMs: number };
} = {}): Promise<{ app: FastifyInstance; h: Harness; desk: StudioDesk }> {
  const h = harness(T0);
  const ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
  await seedStudio(h, 'business');
  await seedInstructor(h);
  await seedPlan(h);
  const desk = await createStudioDesk({ repo: h.repo, events: h.events, now: h.now });
  const app = await buildServer({ desk, logger: false, ...options });
  return { app, h, desk };
}

const servers: FastifyInstance[] = [];
async function tracked(promise: Promise<{ app: FastifyInstance }>): Promise<FastifyInstance> {
  const { app } = await promise;
  servers.push(app);
  return app;
}

afterAll(async () => {
  for (const app of servers) await app.close().catch(() => undefined);
});

describe('authentication', () => {
  it('rejects unauthenticated API calls when a key is set', async () => {
    const app = await tracked(makeServer({ apiKey: API_KEY }));

    const denied = await app.inject({ method: 'GET', url: '/api/members' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error).toBe('unauthorized');
    // Must not leak why it failed or hint at valid values.
    expect(denied.json().message).not.toContain(API_KEY);
  });

  it('accepts a correct bearer token and an x-api-key header', async () => {
    const app = await tracked(makeServer({ apiKey: API_KEY }));

    const viaBearer = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(viaBearer.statusCode).toBe(200);

    const viaHeader = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { 'x-api-key': API_KEY },
    });
    expect(viaHeader.statusCode).toBe(200);
  });

  it('rejects a near-miss key', async () => {
    const app = await tracked(makeServer({ apiKey: API_KEY }));
    for (const candidate of [
      API_KEY.slice(0, -1),
      `${API_KEY}x`,
      API_KEY.toUpperCase(),
      'short',
      '',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/members',
        headers: { authorization: `Bearer ${candidate}` },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('keeps health probes reachable without credentials', async () => {
    const app = await tracked(makeServer({ apiKey: API_KEY }));

    for (const path of ['/health', '/ready', '/']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode, `${path} must be public`).toBe(200);
    }
  });

  it('reports the security posture on /health', async () => {
    const secured = await tracked(makeServer({ apiKey: API_KEY }));
    const body = (await secured.inject({ method: 'GET', url: '/health' })).json();
    expect(body.security.authRequired).toBe(true);
    expect(body.live).toBe(true);

    const open = await tracked(makeServer());
    const openBody = (await open.inject({ method: 'GET', url: '/health' })).json();
    expect(openBody.security.authRequired).toBe(false);
  });

  it('is open in demo mode so `npm run dev:api` works with no setup', async () => {
    const app = await tracked(makeServer());
    const res = await app.inject({ method: 'GET', url: '/api/members' });
    expect(res.statusCode).toBe(200);
  });

  it('never treats a blank API_KEY as a valid credential', async () => {
    // A whitespace-only key must be treated as "no key configured", not as a
    // secret that `Bearer ''` would satisfy.
    const app = await tracked(makeServer({ apiKey: '   ' }));

    const blank = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { authorization: 'Bearer ' },
    });
    expect(blank.statusCode).toBe(200); // open, because the key is unset

    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(health.security.authRequired).toBe(false);
  });
});

describe('production refuses to start misconfigured', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalKey = process.env.API_KEY;

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalKey;
  });

  it('throws when NODE_ENV=production and no API_KEY', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.API_KEY;
    await expect(makeServer()).rejects.toThrow(/API_KEY must be set in production/);
  });

  it('throws when NODE_ENV=production and CORS is wildcard', async () => {
    process.env.NODE_ENV = 'production';
    await expect(makeServer({ apiKey: API_KEY, corsOrigin: '*' })).rejects.toThrow(
      /CORS origin must be an explicit allowlist/,
    );
  });

  it('starts in production when both are configured', async () => {
    process.env.NODE_ENV = 'production';
    const app = await tracked(
      makeServer({ apiKey: API_KEY, corsOrigin: 'https://studio.example.com' }),
    );
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('reads CORS_ORIGIN from the environment as an allowlist', async () => {
    const originalCors = process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://a.example.com,https://b.example.com';

    const app = await tracked(makeServer({ apiKey: API_KEY }));
    for (const origin of ['https://a.example.com', 'https://b.example.com']) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin },
      });
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }

    const evil = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(evil.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');

    if (originalCors === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalCors;
  });

  it('refuses to start when CORS_ORIGIN is a wildcard in production', async () => {
    const originalCors = process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = '*';
    await expect(makeServer({ apiKey: API_KEY })).rejects.toThrow(/explicit allowlist/);

    if (originalCors === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalCors;
  });
});

describe('CORS', () => {
  it('echoes only allowlisted origins', async () => {
    const app = await tracked(makeServer({ corsOrigin: 'https://studio.example.com' }));

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { origin: 'https://studio.example.com' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://studio.example.com');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(denied.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
  });

  it('never pairs a wildcard origin with credentials', async () => {
    const app = await tracked(makeServer({ corsOrigin: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { origin: 'https://anything.example.com' },
    });
    const allowOrigin = res.headers['access-control-allow-origin'];
    const credentials = res.headers['access-control-allow-credentials'];
    expect(!(allowOrigin === '*' && credentials === 'true')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the budget is spent', async () => {
    const app = await tracked(makeServer({ rateLimit: { max: 3, windowMs: 60_000 } }));

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/api/members' });
      statuses.push(res.statusCode);
    }

    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses[3]).toBe(429);

    const limited = await app.inject({ method: 'GET', url: '/api/members' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json().error).toBe('rate_limited');
  });

  it('does not throttle health probes', async () => {
    const app = await tracked(makeServer({ rateLimit: { max: 1, windowMs: 60_000 } }));
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('emits limit headers', async () => {
    const app = await tracked(makeServer({ rateLimit: { max: 10, windowMs: 60_000 } }));
    const res = await app.inject({ method: 'GET', url: '/api/members' });
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('9');
  });
});

describe('security headers', () => {
  it('sets the hardening headers on every response', async () => {
    const app = await tracked(makeServer());
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    // The framework fingerprint must not be advertised.
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('readiness', () => {
  it('reports ready when the repository answers', async () => {
    const app = await tracked(makeServer());
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
  });
});
