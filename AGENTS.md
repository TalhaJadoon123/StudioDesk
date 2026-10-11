# StudioDesk — AI Agent Context

This file provides context for AI coding agents working on StudioDesk. Read this before making changes.

---

## Project Overview

**StudioDesk** is a membership, booking, and billing platform for small gyms/studios.

- **Monorepo**: 9 packages (7 workspaces + 2 standalone)
- **Zero build step**: TypeScript source runs via `tsx` / Next.js / Wrangler
- **Offline-first**: In-memory repo by default, all integrations optional
- **Free-tier deployment**: Cloudflare Workers/Pages, Supabase, Groq, Resend, Polar/LemonSqueezy

---

## Architecture Map

```
packages/
├── shared/     # Types, money, dates, config, errors, events, IDs, plans
├── core/       # Repository, members, classes, bookings, attendance, churn, reports, seed, Supabase
├── booking/    # Calendar, RRULE, waitlist, instructors
├── billing/    # Gateways (Stripe/Polar/LS/manual/mock), packs, drop-ins, fees, dunning, invoices, PDF
├── checkin/    # QR, geofence, kiosk, mobile, manual
├── api/        # Fastify + Workers entrypoint
├── web/        # Next.js (App Router, transpilePackages)
├── mobile/     # Expo (Router, tabs: bookings, schedule, profile, wallet)
└── docs/       # Architecture, Deploy, Operations, Release Gate
```

**Dependency Direction**: `shared → core → (booking, billing, checkin) → api → (web, mobile)`

---

## Key Conventions (MUST FOLLOW)

### TypeScript
- **Strict mode** — `tsconfig.json` has all strict flags
- **No `any`** — Use `unknown` + type narrowing
- **Explicit returns** on all exported functions
- **Branded types** for IDs: `MemberId`, `ClassId`, `BookingId`, etc.
- **Discriminated unions** for state machines
- **Zod schemas** for all external input validation

### Money
- **Integer cents only** — `formatMoney(3900) === '$39.00'`
- **`netCents` clamped** — `MIN_CHARGE_CENTS = 50`
- **No floats** near prices

### Dates
- **UTC ISO strings everywhere** — `toISOString()` only
- **Injected clock** — `now: () => Date` in context for testability
- **No `Date.now()`** in domain logic

### Errors
- **Never throw plain `Error`** — Use `AppError` constructors from `@studiodesk/shared`
- **`try/catch` at boundaries only** — Let errors bubble to route wrapper
- **5xx redaction** — `GENERIC_500_MESSAGE` strips internals

### Testing
- **Pinned clock** — `harness(T0)` in all tests (`packages/core/test/fixtures.ts`)
- **In-memory repository** — No external dependencies
- **Mock gateway** — `createMockGateway()` for payment tests
- **Deterministic** — No flaky tests, no random seeds
- **Run**: `npm test` (294 tests, ~70s)

---

## Package Quick Reference

| Package | Entry Point | Key Exports | Tests |
|---------|-------------|-------------|-------|
| `@studiodesk/shared` | `src/index.ts` | `config`, `money`, `dates`, `errors`, `events`, `ids`, `plans`, `types`, `util`, `validation` | 3 files, 31 tests |
| `@studiodesk/core` | `src/index.ts` | `createStudioDesk`, `members`, `classes`, `bookings`, `attendance`, `churn`, `reports`, `repository`, `seed` | 5 files, 54 tests |
| `@studiodesk/booking` | `src/index.ts` | `calendar`, `recurring`, `waitlist`, `instructor` | 2 files, 27 tests |
| `@studiodesk/billing` | `src/index.ts` | `gateways`, `memberships`, `packs`, `dropIns`, `fees`, `dunning`, `invoices`, `email`, `invoicePdf` | 3 files, 66 tests |
| `@studiodesk/checkin` | `src/index.ts` | `checkin`, `qr`, `geo`, `kiosk`, `mobile`, `manual` | 1 file, 37 tests |
| `@studiodesk/api` | `src/main.ts` (Node), `src/worker.ts` (Workers) | Fastify app, Workers fetch handler | 3 files, 71 tests |

---

## Common Patterns

### Adding a Domain Function

```typescript
// 1. Add Zod schema in packages/shared/src/validation.ts (if new input)
// 2. Add types in packages/shared/src/types.ts (if new entity)
// 3. Implement in domain file (e.g., packages/core/src/members.ts)
// 4. Export from package index.ts
// 5. Add tests in package test/ directory
// 6. Wire into API: packages/api/src/server.ts
```

### Adding an API Route

```typescript
// In packages/api/src/server.ts:
// 1. Import Zod schema: import { createThingSchema } from '@studiodesk/core'
// 2. Define handler using `route()` wrapper
// 3. Use `desk.<domain>.<function>(desk.ctx, input)`
// 4. Return typed response
// 5. Add test in packages/api/test/
```

### Adding a Test

```typescript
// In packages/<domain>/test/<feature>.test.ts:
// 1. Import: import { describe, it, expect } from 'vitest'
// 2. Use harness: const h = harness(T0)
// 3. Use fixtures: seedStudio, seedMember, seedPlan from '@studiodesk/core/test'
// 3. Assert behavior, not implementation
```

---

## Commands Reference

```bash
# Development
npm run dev:api      # API with hot reload (tsx watch)
npm run dev:web      # Next.js dev server
npm run dev:mobile   # Expo dev server

# Testing
npm test             # All 294 tests
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report

# Typechecking
npm run typecheck       # Source
npm run typecheck:tests # Tests
npm run typecheck:all   # Both

# Quality Gates (run all)
npm run release:gate

# Individual gates
npm run verify              # Package entry points
npm run scan:secrets        # Secret scanning
npm run check:deploy        # Dockerfile/compose
npm run check:env           # Env var documentation
npm run audit:errors        # Error throw audit
npm run typecheck:all       # TypeScript

# Build/Deploy
npm run seed:demo           # Seed demo studio
npm run docker:up           # Docker compose
npm run deploy:worker       # Cloudflare Workers
npm run deploy:pages        # Cloudflare Pages
```

---

## Files to NEVER Modify Without Human Review

- `constitution.md` — Project principles
- `spec.md` — Requirements
- `plan.md` — Technical plan
- `tasks.md` — Task breakdown
- `checklist.md` — Acceptance criteria
- `package.json` (version, dependencies) — Requires version bump
- `tsconfig.json` / `tsconfig.test.json` — Compiler config
- `.github/workflows/ci.yml` — CI pipeline
- `Dockerfile` / `docker-compose.yml` — Deployment config
- `wrangler.toml` — Workers config
- `vitest.config.ts` — Test config

---

## Environment Variables

All env vars documented in `.env.example` (45 vars, validated by `check-env-docs.cjs`).

**Critical for production**:
- `API_KEY` — Required, server refuses boot without
- `CORS_ORIGIN` — Explicit HTTPS origins, no `*`
- `NODE_ENV=production`
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (if using persistence)
- Payment secrets via Cloudflare Workers secrets

---

## Debugging Tips

| Issue | Check |
|-------|-------|
| Test flaky | Pinned clock? `harness(T0)` used? |
| Type error | `tsc --noEmit` shows exact location |
| Auth failing | `API_KEY` set? `CORS_ORIGIN` correct? |
| Payment failing | Mock gateway vs real? Idempotency key? |
| Build failing | `npm ci` vs `npm install`? Lockfile sync? |

---

## Useful Grep Patterns

```bash
# Find all API routes
grep -r "app\.(get|post|put|patch|delete)" packages/api/src/server.ts

# Find all Zod schemas
grep -r "z\." packages/shared/src/validation.ts

# Find all AppError throws
grep -r "new AppError\|notFound\|validationFailed\|conflict" packages/

# Find all event emissions
grep -r "ctx.events.emit" packages/

# Find all repository calls
grep -r "\.table\(" packages/core/src/
```

---

## When Stuck

1. Check `packages/docs/OPERATIONS.md` for failure modes
2. Check `packages/docs/ARCHITECTURE.md` for design rationale
3. Run `npm run release:gate` to see which gate fails
4. Read the test for the feature you're modifying
5. Ask in GitHub Discussions — don't guess