# StudioDesk Constitution

**Version:** 1.0.0
**Last Updated:** 2026-10-11
**Status:** Active

---

## 1. Project Principles

### 1.1 Core Mission
StudioDesk is a membership, booking, and billing platform for small gyms and studios. Every feature must serve this mission directly — no feature creep.

### 1.2 Zero-Cost Deployment
The application must run entirely on free tiers:
- Cloudflare Workers/Pages (100k requests/day, 500 builds/month)
- Supabase (500 MB database, 1 GB storage)
- Groq (generous free tier for AI)
- Resend/useSend (3,000 emails/month)
- Polar/LemonSqueezy (no monthly fee, per-transaction only)
- EU.org or `pages.dev` domains

No feature may require a paid tier to function.

### 1.3 Offline-First Architecture
Every external integration degrades gracefully:
- No Supabase → in-memory repository (data lost on restart, but fully functional)
- No Groq → deterministic churn heuristics only
- No payment gateways → offline mode (record payments manually)
- No email provider → in-app notifications only
- No domain → `workers.dev` / `pages.dev` subdomains

### 1.4 Single Source of Truth
- TypeScript source is the only artifact — no build step, no `dist` directories
- `tsx` runs in development, Next.js transpiles, Wrangler bundles
- Zod schemas are the single source of validation truth
- Domain rules live in `packages/core` — API, web, and tests all call the same functions

---

## 2. Technology Standards

### 2.1 Language & Runtime
- **TypeScript** (strict mode) — all code, including tests
- **Node.js** >= 20.11 — LTS only
- **ES Modules** — `type: "module"` in all `package.json`

### 2.2 Frameworks
| Layer | Framework | Version Policy |
|-------|-----------|----------------|
| API (Node) | Fastify | ^5.x (latest stable) |
| API (Edge) | Cloudflare Workers | wrangler.toml pinned compatibility_date |
| Web | Next.js | ^14.x (App Router) |
| Mobile | Expo | ~52.x (SDK aligned) |
| Validation | Zod | ^3.x (v4 migration planned) |
| Testing | Vitest | ^2.x |

### 2.3 Package Management
- **npm workspaces** for 7 internal packages (`packages/*`)
- **Standalone installs** for `packages/web` and `packages/mobile` (Next.js/Expo are heavy)
- **Lockfile committed** — `package-lock.json` at root
- **No post-install scripts** in dependencies

### 2.4 Code Style (Enforced via CI)
- **ESLint** with `@typescript-eslint` — strict rules
- **Prettier** — single quotes, 2 spaces, trailing commas
- **TypeScript strict** — `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- **No `any`** — use `unknown` and narrow

---

## 3. Security Requirements

### 3.1 Authentication
- **API_KEY required in production** — server refuses to boot without it
- **Bearer token** (`Authorization: Bearer <key>`) or **header** (`X-Api-Key: <key>`)
- **Timing-safe comparison** for key validation
- **Health probes (`/health`, `/ready`) always public** — orchestrators must reach them

### 3.2 CORS
- **Explicit allowlist required in production** — `CORS_ORIGIN` (comma-separated)
- **Wildcard (`*`) blocked in production** — server refuses to boot
- **Credentials only with explicit origin** — never with `*`

### 3.3 Rate Limiting
- **Fixed-window** — 300 requests/minute/IP default
- **Standard headers** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
- **Health probes exempt**

### 3.4 Security Headers (All Responses)
| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-DNS-Prefetch-Control` | `off` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.groq.com https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` |
| `X-Powered-By` | Removed |

### 3.5 Error Handling
- **5xx responses never leak internals** — `GENERIC_500_MESSAGE: "Something went wrong on our side."`
- **4xx responses return full details** — validation errors, conflicts, etc.
- **Typed error hierarchy** — `AppError` with `ErrorCode` enum

### 3.6 Secrets
- **Never committed** — `.gitignore` covers `.env`, `.env.local`, `*.key`, `*.pem`, etc.
- **Scanned in CI** — `scan-secrets.cjs` with self-test
- **Injected at runtime** — Cloudflare Workers secrets, Docker compose env vars
- **Test fixtures use obvious placeholders** — `whsec_test_secret`, `test-api-key-0123456789abcdef`

### 3.7 Payments
- **Idempotency keys required** on all payment operations
- **Mock gateway** for tests — records calls, fails on demand
- **No SDKs** — plain `fetch` + `AbortController` (works on Workers)

---

## 4. Performance Expectations

| Metric | Target | Measurement |
|--------|--------|-------------|
| API p99 latency | < 200 ms | Local + staging load test |
| Cold start (Workers) | < 50 ms | Wrangler deploy metrics |
| Test suite | < 60 s | `npm test` on CI |
| Typecheck | < 60 s | `npm run typecheck:all` |
| Docker image size (API) | < 200 MB | `docker images` |
| Bundle size (Web) | < 500 KB gzipped | Next.js build output |

---

## 5. Coding Conventions

### 5.1 TypeScript
- **Explicit return types** on all exported functions
- **Discriminated unions** over optional fields for state machines
- **Branded types** for IDs (`MemberId`, `ClassId`, etc.)
- **`const` assertions** for literal types
- **No enums** — use `const` objects with `as const`

### 5.2 Error Handling
- **Never throw plain `Error`** in production code — use `AppError` constructors
- **`try/catch` at boundaries only** — let errors bubble to route wrapper
- **Structured logging** — pino with `reqId`, `path`, `method`

### 5.3 Money
- **Integer cents only** — `formatMoney(3900) === '$39.00'`
- **`netCents` clamped** — `MIN_CHARGE_CENTS = 50`
- **No floats** near prices

### 5.4 Dates
- **UTC ISO strings everywhere** — `toISOString()` only
- **Injected clock** — `now: () => Date` in context for testability
- **No `Date.now()`** in domain logic

### 5.4 Testing
- **Pinned clock** — `harness(T0)` in all tests
- **In-memory repository** — no external dependencies
- **Mock gateway** — `createMockGateway()` with recorded calls
- **Deterministic** — no flaky tests, no random seeds

---

## 6. Compliance Needs

### 6.1 Data Privacy
- **No PII in logs** — request IDs only
- **Member data encrypted at rest** (Supabase) or in-memory only
- **Right to deletion** — `DELETE /api/members/:id` cascades

### 6.2 Financial
- **PCI SAQ-A** — no card data touches our servers (Stripe/Polar/LemonSqueezy handle it)
- **Idempotency** — prevents double-charging
- **Audit trail** — all payments recorded with timestamps

### 6.3 Accessibility
- **WCAG 2.1 AA** target for web app
- **Semantic HTML** — Next.js App Router defaults
- **Focus management** — Expo Router handles mobile

---

## 7. Amendment Process

1. Propose change via GitHub Issue with `constitution` label
2. Discuss in PR — require 2 approvals from maintainers
3. Update version in this file (semver: MAJOR for breaking principles, MINOR for additions, PATCH for clarifications)
4. Merge to `main` — CI enforces all gates

---

## 8. Non-Goals

- **Multi-tenancy** — single studio per deployment
- **Real-time sync** — polling is sufficient for studio scale
- **Complex RBAC** — staff vs admin is enough
- **White-labeling** — not in scope