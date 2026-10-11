# StudioDesk Technical Plan

**Version:** 1.0.0
**Status:** Implemented
**Related:** `constitution.md`, `spec.md`, `tasks.md`, `checklist.md`

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Consumers                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Web App   │  │  Mobile App │  │   External Consumers    │ │
│  │  (Next.js)  │  │   (Expo)    │  │   (API_KEY auth)        │ │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘ │
└─────────┼────────────────┼─────────────────────┼───────────────┘
          │                │                     │
          ▼                ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API Layer                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Fastify (Node)          │ Cloudflare Workers (Edge)         │ │
│  │ • Auth (API_KEY)        │ • Same routes, same logic         │ │
│  │ • CORS + Rate Limit     │ • Cron triggers (0 3 * * *)       │ │
│  │ • Security Headers      │ • Observability enabled           │ │
│  │ • Request ID + Logging  │ • Secrets via wrangler secret     │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Domain Layer (packages/core)               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Members  │ │ Classes  │ │ Bookings │ │Attend.   │ │Churn   │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Plans    │ │Reports   │ │Notifications│ │Seed    │ │Supabase│ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Repository Abstraction (MemoryRepository / SupabaseRepository)│
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────┬───────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  packages/       │ │  packages/       │ │  packages/       │
│  booking         │ │  billing         │ │  checkin         │
│  • Calendar      │ │  • Gateways      │ │  • QR tickets    │
│  • RRULE         │ │  • Packs/Drop-ins│ │  • Geofence      │
│  • Waitlist      │ │  • Fees/Dunning  │ │  • Kiosk         │
│  • Instructors   │ │  • Invoices/PDF  │ │  • Mobile/Manual │
└──────────────────┘ └──────────────────┘ └──────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Shared Foundation (packages/shared)        │
│  Types • Money • Dates • Config • Errors • Events • IDs • Plans │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Model

### 2.1 Core Entities (Single JSONB Table: `records`)

```typescript
// All entities share this shape (SupabaseRepository)
interface Record<T extends TableName> {
  id: string;           // ULID
  type: TableName;      // Discriminator
  data: Tables[T];      // Entity-specific payload
  createdAt: string;    // ISO 8601 UTC
  updatedAt: string;    // ISO 8601 UTC
  studioId: string;     // Studio scoping
}
```

| Table | Key Fields | Relationships |
|-------|------------|---------------|
| `studios` | `id`, `name`, `tier`, `limits`, `settings` | Root |
| `members` | `id`, `studioId`, `name`, `email`, `phone`, `planId`, `status`, `packBalance`, `tags` | → `plans`, → `bookings`, → `attendance` |
| `plans` | `id`, `studioId`, `name`, `tier`, `monthlyPriceCents`, `limits` | ← `members` |
| `classes` | `id`, `studioId`, `instructorId`, `name`, `capacity`, `rrule`, `priceCents` | → `instructors`, → `bookings` |
| `instructors` | `id`, `studioId`, `name`, `email`, `color` | ← `classes` |
| `bookings` | `id`, `studioId`, `memberId`, `classId`, `status`, `packUsed`, `dropInUsed` | → `members`, → `classes` |
| `attendance` | `id`, `studioId`, `memberId`, `classId`, `status`, `method`, `checkInAt` | → `members`, → `classes` |
| `memberships` | `id`, `studioId`, `memberId`, `planId`, `status`, `currentPeriodEnd`, `gateway` | → `members`, → `plans` |
| `invoices` | `id`, `studioId`, `memberId`, `items[]`, `totalCents`, `status`, `pdfUrl` | → `members` |
| `classPacks` | `id`, `studioId`, `memberId`, `creditsTotal`, `creditsUsed`, `expiresAt` | → `members` |
| `dropIns` | `id`, `studioId`, `memberId`, `classId`, `priceCents`, `status` | → `members`, → `classes` |
| `fees` | `id`, `studioId`, `memberId`, `type`, `amountCents`, `status`, `bookingId?` | → `members`, → `bookings` |
| `notifications` | `id`, `studioId`, `memberId?`, `type`, `title`, `body`, `readAt` | → `members` |

### 2.2 Repository Interface

```typescript
interface Repository {
  table<T extends TableName>(name: T): TableRepository<T>;
  transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T>;
  // Event bus for cross-package communication
  events: EventBus;
}
```

**MemoryRepository** — in-memory `Map<string, Record>` with filter language
**SupabaseRepository** — single `records` table, RLS enabled, service role only

---

## 3. Interface Contracts

### 3.1 HTTP API (Fastify + Workers)

All routes prefixed with `/api` (except `/health`, `/ready`, `/`).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | Public | Liveness + integration status |
| GET | `/ready` | Public | Readiness (repo connectivity) |
| GET | `/api/studio` | API_KEY | Studio config + tier + limits |
| GET/POST/PATCH/DELETE | `/api/members` | API_KEY | Member CRUD |
| GET/POST/PATCH/DELETE | `/api/plans` | API_KEY | Plan CRUD |
| GET/POST/PATCH/DELETE | `/api/instructors` | API_KEY | Instructor CRUD |
| GET/POST/PATCH/DELETE | `/api/classes` | API_KEY | Class CRUD |
| GET | `/api/schedule` | API_KEY | Week/month grid |
| POST | `/api/schedule/series` | API_KEY | Create recurring series |
| POST | `/api/bookings` | API_KEY | Create booking |
| DELETE | `/api/bookings/:id` | API_KEY | Cancel booking |
| POST | `/api/checkin` | API_KEY | QR/GPS check-in |
| POST | `/api/checkin/verify` | API_KEY | Verify ticket |
| GET/POST | `/api/kiosk/:deviceId/*` | Public* | Kiosk mode |
| POST | `/api/billing/subscribe` | API_KEY | Start membership |
| POST | `/api/billing/packs` | API_KEY | Purchase pack |
| POST | `/api/billing/drop-ins` | API_KEY | Purchase drop-in |
| GET/POST | `/api/billing/dunning` | API_KEY | Dunning management |
| GET | `/api/reports/*` | API_KEY | Revenue/attendance/churn |
| POST | `/api/invoices/:id/pdf` | API_KEY | Generate invoice PDF |

*Kiosk landing is public; check-in requires device pairing.

### 3.2 Internal Service APIs (TypeScript)

Each domain package exports typed functions — **no HTTP between packages**.

```typescript
// packages/core/src/members.ts
export async function createMember(ctx: CoreContext, input: CreateMemberInput): Promise<Member>
export async function pauseMember(ctx: CoreContext, memberId: string): Promise<Member>
export async function cancelMember(ctx: CoreContext, memberId: string): Promise<Member>

// packages/booking/src/waitlist.ts
export async function promoteAndNotify(ctx: CoreContext, classId: string): Promise<Booking[]>

// packages/billing/src/gateway.ts
export interface PaymentGateway {
  createCustomer(input: CreateCustomerInput): Promise<Customer>;
  createPayment(input: CreatePaymentInput): Promise<PaymentResult>;
  // ...
}
export function createMockGateway(): PaymentGateway & MockControls;

// packages/checkin/src/checkin.ts
export async function checkin(ctx: CoreContext, input: CheckinInput): Promise<Attendance>
export async function verifyTicket(ctx: CoreContext, ticket: string): Promise<VerifyResult>
```

---

## 4. Research Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|-------------------------|
| **Single JSONB table** | No migrations, flexible schema, RLS simple | Separate tables (more DDL, rigid) |
| **In-memory default repo** | Zero-cost demo, fast tests, no external deps | SQLite file (still needs persistence) |
| **No build step** | `tsx` / Next / Wrangler all consume TS source | `tsc` → `dist` (stale artifacts, slower dev) |
| **Zod for validation** | Single schema → types + runtime validation | `class-validator` (decorators, heavier) |
| **Event bus for cross-package** | No dependency cycles, testable | Direct imports (cycles), message queue (overkill) |
| **Integer cents for money** | No floating-point bugs, exact arithmetic | `decimal.js` (dependency), `bigint` (no JSON) |
| **Pinned clock in tests** | Deterministic, no flaky time-based tests | `Date.now()` (flaky), `jest.useFakeTimers` (complex) |
| **Mock gateway for payments** | Fast tests, no network, fail-on-demand | Stripe test mode (slow, network) |
| **RRULE via `rrule` lib** | RFC 5545 compliant, handles edge cases | Custom parser (bugs, maintenance) |
| **HMAC-signed QR tickets** | Stateless, tamper-proof, short-lived | JWT (larger), DB lookup (stateful) |
| **Groq only for narratives** | Deterministic heuristic first, AI only explains | Full AI churn (hallucination risk) |
| **Fastify over Express** | Performance, TypeScript-native, plugin ecosystem | Express (older), Hono (Workers-native but less mature) |
| **Workers for edge API** | Free tier generous, same code as Node | Separate Edge codebase (duplication) |

---

## 5. Constitution Check

| Constitution Principle | Compliance | Evidence |
|------------------------|------------|----------|
| Zero-cost deployment | ✅ | All services free tier |
| Offline-first | ✅ | In-memory repo, mock gateway |
| Single source of truth | ✅ | TS source, Zod schemas, shared core |
| API_KEY required in prod | ✅ | `server.ts:134-138` refuses boot |
| Explicit CORS allowlist | ✅ | `server.ts:139-140` refuses `*` |
| Rate limiting | ✅ | 300/min/IP, headers |
| Security headers | ✅ | HSTS, CSP, X-Frame-Options, etc. |
| 5xx redaction | ✅ | `GENERIC_500_MESSAGE` |
| Integer cents money | ✅ | `shared/money.ts` |
| UTC ISO dates | ✅ | `shared/dates.ts` |
| Deterministic tests | ✅ | Pinned clock, 3-run verification |
| No plain `Error` in prod | ⚠️ | 3 in billing (documented, test-only) |

---

## 6. Deployment Strategy

| Environment | API | Web | Database | Trigger |
|-------------|-----|-----|----------|---------|
| Local | `tsx packages/api/src/main.ts` | `npm run dev:web` | Memory | Manual |
| Staging | Cloudflare Workers (staging) | Cloudflare Pages (staging) | Supabase (staging) | Push to `main` |
| Production | Cloudflare Workers (prod) | Cloudflare Pages (prod) | Supabase (prod) | Git tag `v*` |

**Rollback:** `wrangler rollback` (Workers), Pages deploy history (Web), Supabase PITR (DB)

---

## 7. Monitoring & Alerting (Future)

| Signal | Alert Threshold | Action |
|--------|-----------------|--------|
| API error rate | > 1% for 5 min | Page on-call |
| `/ready` failing | > 30 s | Page on-call |
| Workers CPU time | > 8 ms avg | Optimize |
| Supabase storage | > 400 MB | Archive old data |
| Dunning queue | > 50 stuck | Manual review |