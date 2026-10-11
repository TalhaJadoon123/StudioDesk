# StudioDesk Task Breakdown

**Version:** 1.0.0
**Status:** Implemented (v1.0)
**Related:** `constitution.md`, `spec.md`, `plan.md`, `checklist.md`

---

## Task Format
- **ID**: Unique identifier (domain.sequence)
- **Story**: User story reference
- **Type**: `feat` | `fix` | `refactor` | `test` | `docs` | `chore` | `security`
- **Priority**: `P0` (blocker) | `P1` (required) | `P2` (nice-to-have)
- **Depends On**: Task IDs that must complete first
- **Testable**: Independent verification criteria

---

## Domain: Shared Foundation

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| SH-01 | feat | P0 | TypeScript strict config with path aliases | — | `tsc --noEmit` passes |
| SH-02 | feat | P0 | Money utilities (cents, formatting, clamping) | SH-01 | `money.test.ts` 5/5 pass |
| SH-03 | feat | P0 | Date utilities (UTC ISO, pinned clock support) | SH-01 | `dates.test.ts` 8/8 pass |
| SH-04 | feat | P0 | Config system (env access, validation, cleaning) | SH-01 | `check-env-docs.cjs` 0 blockers |
| SH-05 | feat | P0 | Error hierarchy (AppError, ErrorCode, toErrorBody) | SH-01 | `errors.ts` exports all codes |
| SH-06 | feat | P0 | Event bus (typed, async, testable) | SH-01 | `core-utils.test.ts` 18/18 pass |
| SH-07 | feat | P0 | ID generation (ULID, branded types) | SH-01 | `ids.ts` exports branded types |
| SH-08 | feat | P0 | Plan catalog (tiers, limits, enforcement helpers) | SH-01 | `plans.ts` exports limits |
| SH-09 | test | P0 | Core utils tests (utils, money, dates) | SH-02..SH-08 | 31 tests pass |

---

## Domain: Core (Repository + Domain Logic)

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| CR-01 | feat | P0 | Repository interface + MemoryRepository | SH-01..SH-08 | `repository.test.ts` 13/13 pass |
| CR-02 | feat | P0 | SupabaseRepository (JSONB, RLS, service role) | CR-01 | `drivers.test.ts` 3/3 pass |
| CR-03 | feat | P0 | Member CRUD + pause/resume/cancel + capacity | CR-01 | `members.test.ts` 21/21 pass |
| CR-04 | feat | P0 | Plan CRUD + tier limits enforcement | CR-01 | `plans.ts` limits enforced |
| CR-05 | feat | P0 | Class CRUD + RRULE parsing/expansion | CR-01 | `recurring.test.ts` 17/17 pass |
| CR-06 | feat | P0 | Booking CRUD + pack/drop-in logic | CR-01, CR-03 | `bookings.test.ts` 23/23 pass |
| CR-07 | feat | P0 | Waitlist auto-promotion (no gaps, skip inactive) | CR-06 | `waitlist.ts` + `bookings.test.ts` |
| CR-08 | feat | P0 | Attendance (check-in, manual, roll call) | CR-01, CR-03 | `attendance.ts` tests |
| CR-09 | feat | P0 | Churn heuristicRisk (deterministic 0-1 + signals) | CR-01, CR-03 | `churn.ts` + `churn.test.ts` |
| CR-10 | feat | P0 | Groq AI enrichment (Business only, JSON parse) | CR-09 | `groq.ts` + mock in tests |
| CR-11 | feat | P0 | Reports (revenue, attendance, churn, dashboard) | CR-01..CR-10 | `reports.ts` tests |
| CR-12 | feat | P0 | Seed script (100 members, 8 weeks, 241 classes, 1832 bookings) | CR-01..CR-11 | `seed:demo` works |
| CR-13 | test | P0 | Core domain tests (members, bookings, repository, drivers, smoke) | CR-01..CR-12 | 54 tests pass |

---

## Domain: Booking (Calendar + RRULE + Waitlist)

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| BK-01 | feat | P0 | Calendar grid (week/month) + conflict detection | CR-05 | `calendar.test.ts` 10/10 pass |
| BK-02 | feat | P0 | RRULE parsing (DTSTART, COUNT, UNTIL, BYDAY, etc.) | CR-05 | `recurring.test.ts` 17/17 pass |
| BK-03 | feat | P0 | Waitlist promotion (notify, skip paused, no gaps) | CR-07 | `waitlist.ts` logic tested |
| BK-04 | feat | P0 | Instructor load tracking | CR-05 | `instructor.ts` |
| BK-05 | test | P0 | Booking package tests | BK-01..BK-04 | 27 tests pass |

---

## Domain: Billing (Gateways + Packs + Fees + Dunning + PDF)

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| BL-01 | feat | P0 | PaymentGateway interface + fetch-based adapters | CR-01 | `gateway.ts` |
| BL-02 | feat | P0 | Mock gateway (record, fail-on-demand, idempotency) | BL-01 | `gateway.test.ts` 19/19 pass |
| BL-03 | feat | P0 | Stripe adapter (one-off only, no recurring) | BL-01 | `stripe.ts` |
| BL-04 | feat | P0 | Polar adapter (recurring subscriptions) | BL-01 | `gateway.ts` |
| BL-05 | feat | P0 | LemonSqueezy adapter (alt recurring) | BL-01 | `gateway.ts` |
| BL-06 | feat | P0 | Manual gateway (offline mode) | BL-01 | `gateway.ts` |
| BL-07 | feat | P0 | Membership lifecycle (create, cancel, renew, dunning) | CR-03, BL-01 | `memberships.ts` |
| BL-08 | feat | P0 | Class packs (credits, expiry, prorated upgrade) | CR-03 | `class-packs.ts` |
| BL-09 | feat | P0 | Drop-ins (one-off, Stripe only) | CR-03, CR-05 | `drop-ins.ts` |
| BL-10 | feat | P0 | Late-cancel / no-show fees (configurable, waivable) | CR-06, CR-08 | `fees.ts` |
| BL-11 | feat | P0 | Dunning state machine (4 stages, pause on final) | BL-07 | `dunning.ts` |
| BL-12 | feat | P0 | Invoice generation + PDF (optional pdfme) | BL-07 | `invoice-pdf.ts` + CLI |
| BL-13 | feat | P0 | Email notifications (Resend/useSend, in-app fallback) | BL-07 | `email.ts` |
| BL-14 | test | P0 | Billing package tests | BL-01..BL-13 | 66 tests pass |

---

## Domain: Check-in (QR + Geofence + Kiosk + Mobile + Manual)

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| CI-01 | feat | P0 | QR tickets (HMAC: sd1.id.nonce.expiry.hmac) | CR-03, CR-08 | `qr.ts` |
| CI-02 | feat | P0 | GPS geofence (Haversine, configurable radius) | CI-01 | `geo.ts` |
| CI-03 | feat | P0 | Kiosk mode (device pairing, landing, check-in) | CI-01 | `kiosk.ts` |
| CI-04 | feat | P0 | Mobile check-in (Expo camera, location) | CI-01 | `mobile.ts` |
| CI-05 | feat | P0 | Manual roll call (instructor marks attended/absent) | CR-08 | `manual.ts` |
| CI-06 | test | P0 | Check-in package tests | CI-01..CI-05 | 37 tests pass |

---

## Domain: API (Fastify + Workers)

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| AP-01 | feat | P0 | Fastify server with typed routes | All domains | `api.test.ts` 31/31 pass |
| AP-02 | feat | P0 | Hand-rolled CORS (explicit allowlist, no `*` in prod) | AP-01 | `security.test.ts` CORS tests |
| AP-03 | feat | P0 | API_KEY auth (Bearer + X-Api-Key, timing-safe) | AP-01 | `security.test.ts` auth tests |
| AP-04 | feat | P0 | Rate limiting (300/min, headers, health exempt) | AP-01 | `security.test.ts` rate tests |
| AP-05 | feat | P0 | Security headers (HSTS, CSP, X-Frame-Options, etc.) | AP-01 | `security.test.ts` header tests |
| AP-06 | feat | P0 | Request ID + structured logging (pino) | AP-01 | `security.test.ts` |
| AP-07 | feat | P0 | /health (liveness) + /ready (readiness) | AP-01 | `security.test.ts` health tests |
| AP-08 | feat | P0 | Graceful shutdown (10s, SIGINT/SIGTERM) | AP-01 | `main.ts` |
| AP-09 | feat | P0 | Cloudflare Workers entrypoint (same routes, cron) | AP-01 | `worker.ts` |
| AP-10 | feat | P0 | API E2E tests (32-booking fixture, 100-member seed) | AP-01..AP-09 | `e2e.test.ts` 21/21 pass |
| AP-11 | test | P0 | API package tests | AP-01..AP-10 | 71 tests pass |

---

## Domain: Web (Next.js)

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| WB-01 | feat | P0 | Next.js App Router with transpilePackages | AP-01 | `npm run build` |
| WB-02 | feat | P0 | Dashboard (KPIs, charts, alerts) | AP-01 | Manual |
| WB-03 | feat | P0 | Member management UI (CRUD, packs, billing) | AP-01 | Manual |
| WB-04 | feat | P0 | Schedule UI (week/month grid, booking) | AP-01 | Manual |
| WB-05 | feat | P0 | Reports UI (revenue, attendance, churn) | AP-01 | Manual |
| WB-06 | feat | P0 | Kiosk mode UI (device landing, check-in) | AP-01 | Manual |
| WB-07 | feat | P0 | Marketing pages + pricing + health-check | AP-01 | Manual |
| WB-08 | feat | P0 | Webhook handlers (Stripe, Polar, LemonSqueezy) | BL-03..BL-05 | Manual |
| WB-09 | chore | P1 | ESLint + Prettier + typecheck in CI | — | CI passes |

---

## Domain: Mobile (Expo)

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| MB-01 | feat | P0 | Expo Router tabs (bookings, schedule, profile, wallet) | AP-01 | Manual |
| MB-02 | feat | P0 | Check-in flow (camera QR, GPS geofence) | CI-01, CI-02 | Manual |
| MB-03 | feat | P0 | Booking flow (view, book, cancel, waitlist) | CR-06 | Manual |
| MB-04 | feat | P0 | Wallet (packs, drop-ins, invoices) | BL-08, BL-09, BL-12 | Manual |
| MB-05 | feat | P0 | Secure storage (tokens, offline queue) | AP-03 | Manual |
| MB-06 | chore | P1 | Typecheck + ESLint in CI | — | CI passes |

---

## Domain: Documentation & Release

| ID | Type | Priority | Title | Depends On | Testable |
|----|------|----------|-------|------------|----------|
| DC-01 | docs | P0 | README (setup, architecture, deploy) | — | Exists |
| DC-02 | docs | P0 | DEPLOY.md (free-tier guide) | — | Exists |
| DC-03 | docs | P0 | ARCHITECTURE.md (monorepo, deps, data model) | — | Exists |
| DC-04 | docs | P0 | OPERATIONS.md (runbook, limits, failure modes) | — | Exists |
| DC-05 | docs | P0 | RELEASE-GATE.md (gate commands, limitations) | — | Exists |
| DC-06 | docs | P0 | constitution.md, spec.md, plan.md, tasks.md, checklist.md | — | **NEW** |
| DC-07 | docs | P1 | CONTRIBUTING.md, SECURITY.md, AGENTS.md | — | **NEW** |
| DC-08 | chore | P0 | Release gate scripts (verify, secrets, deploy, env, errors) | — | `npm run release:gate` |
| DC-09 | chore | P0 | Dockerfile (multi-stage, non-root, tini) + compose | — | `check-deploy-config.cjs` |
| DC-10 | chore | P1 | GitHub Actions CI (test, typecheck, security, build) | — | **NEW** |
| DC-11 | chore | P2 | CodeQL + Trivy + SBOM in CI | DC-10 | **NEW** |

---

## Task Dependencies Graph (Critical Path)

```
SH-01..SH-09
    │
    ├─► CR-01..CR-02 (Repository)
    │       │
    │       ├─► CR-03 (Members) ──► CR-06 (Bookings) ──► CR-07 (Waitlist)
    │       │                         │
    │       ├─► CR-04 (Plans)         ├─► CR-08 (Attendance)
    │       │                         │
    │       ├─► CR-05 (Classes/RRULE) ├─► BK-01..BK-04
    │       │                         │
    │       └─► CR-09 (Churn) ◄───────┘
    │                 │
    │                 ├─► CR-10 (Groq AI)
    │                 │
    │                 └─► CR-11 (Reports)
    │
    ├─► BL-01..BL-06 (Gateways) ──► BL-07..BL-13 (Billing)
    │       │
    │       └─► CI-01 (QR) ──► CI-02..CI-05 (Check-in)
    │
    └─► AP-01 (API) ──► AP-02..AP-10 (Security, Health, Workers)
            │
            ├─► WB-01..WB-08 (Web)
            └─► MB-01..MB-05 (Mobile)
```

---

## Verification Checklist per Task

Every task must satisfy:
- [ ] TypeScript compiles (`tsc --noEmit`)
- [ ] Unit tests pass (`vitest run packages/<domain>/test/`)
- [ ] No new `npm audit --omit=dev` vulnerabilities
- [ ] No secrets in tracked files (`scan-secrets.cjs`)
- [ ] Deploy config passes (`check-deploy-config.cjs`)
- [ ] Env docs pass (`check-env-docs.cjs`)
- [ ] Error audit passes (`audit-error-throws.cjs`)