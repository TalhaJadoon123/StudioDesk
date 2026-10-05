# Architecture

## Why a monorepo with no build step

Nine packages, one `node_modules`, zero `dist` directories. Every internal
package points `main` at its TypeScript source:

```json
{ "main": "./src/index.ts", "types": "./src/index.ts" }
```

Three consumers, one source of truth:

| Consumer   | How it loads the packages                          |
|------------|----------------------------------------------------|
| API (dev)  | `tsx` transpiles on the fly                        |
| Web        | Next.js `transpilePackages`                        |
| Workers    | Wrangler/esbuild bundles them                      |
| Tests      | `vitest.config.ts` aliases                         |

No build outputs to drift, no stale `dist`, and a change to `shared` is visible
everywhere on the next reload. The trade-off is that anything consuming these
packages needs a TS-aware runtime — which all four above already are.

## Dependency direction

```
shared   ← zero dependencies, safe on any runtime
   ↑
core     ← repository, domain rules, churn, reports, seed
   ↑           ↑
booking  billing  checkin     (each depends only on core)
   ↑            ↑     ↑
   └────────────┴─────┘
              ↑
             api        (Fastify + a Workers entrypoint)
              ↑
          web · mobile
```

`core` never imports `booking`, `billing` or `checkin`. Cross-package behaviour
is wired with the event bus, which is why a class cancellation can trigger fee
assessment without a dependency cycle:

```ts
// billing/fees.ts
ctx.events.on('booking.cancelled', async ({ late }) => { /* assess a fee */ });
ctx.events.on('class.completed',  async ({ classId }) => { /* no-show fees */ });
ctx.events.on('class.cancelled',  async ({ classId }) => { /* waive fees   */ });
```

Every handler returns a disposable, so tests and shutdown stay clean.

## The repository

The only abstraction that knows where data lives.

```ts
interface Repository {
  readonly kind: 'memory' | 'supabase';
  table<T extends TableName>(name: T): Table<Row<T>>;
  transaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T>;
}
```

Two drivers ship:

- **`MemoryRepository`** — the default. Deep-clones on every read, so callers
  cannot mutate stored rows by accident.
- **`SupabaseRepository`** — one JSONB row per entity in a `records` table.
  Chosen automatically when credentials are present.

The filter language is a small superset of SQL:

```ts
{ status: 'booked' }                          // equality
{ startTime: { $gte: from, $lte: to } }       // range (multiple operators allowed)
{ status: { $in: ['a', 'b'] } }
{ $or: [{ a: 1 }, { b: 2 }] }                // groups
{ $isNull: true }                            // null checks
```

The same language compiles to PostgREST in the Supabase driver.

## Supabase schema

```sql
create table records (
  table_name text not null,
  id         text not null,
  data       jsonb not null default '{}',
  primary key (table_name, id)
);
```

Why one JSONB table rather than sixteen typed ones:

- The free tier stays small and index-only queries stay fast (`GIN` on `data`)
- Onboarding a studio needs no DDL
- Adding a field is a one-line type change with no migration
- Row Level Security is one policy instead of sixteen

The cost is that you lose column-level types. If you need them,
`packages/core/src/supabase.ts` is the only file to change.

## Clock injection

Every service that reads the current time takes it from `ctx.now`, never
`Date.now()`:

```ts
const ctx = createContext({ now: () => new Date(fixedInstant) });
```

This is what makes "no-shows in the last 30 days" testable, and it caught a real
bug: `assertBookable` used `Date.now()`, so every class more than an hour in the
future looked like it had already started. `setCheckinClock()` does the same
job for QR tickets.

## Payments

`PaymentGateway` is a six-method interface. Five implementations:

| Gateway        | For                                    | Cost        |
|----------------|----------------------------------------|-------------|
| `polar`        | Subscriptions ($39/$99)               | 4% + 40c    |
| `lemonsqueezy` | Subscriptions, Pakistan-friendly      | 5% + 50c    |
| `stripe`       | One-off charges only, no subscriptions | 2.9% + 30c  |
| `manual`       | No keys: cash and bank transfers       | free        |
| `mock`         | Tests: records every call             | free        |

Every adapter talks to the REST API over `fetch` rather than importing an SDK.
That removes four dependencies and lets the same code run on Workers.

Idempotency keys make charges safe to retry:

```ts
chargeKey('class-pack', memberId, invoiceId)  // "sd_class-pack_mem_x_inv_y"
```

## Churn scoring

Two layers, deliberately separated:

1. **`heuristicRisk()`** — deterministic, explainable, free. Always runs.
   Produces a 0–1 score and a signal breakdown. Features: visit frequency
   change, days since last visit, attendance rate, late cancels, no-shows,
   outstanding balance, tenure, upcoming bookings.
2. **`enrichWithGroq()`** — Business plan only. Turns those signals into prose
   and a concrete next action. Skipped entirely without a key.

The model never changes the score. That keeps results reproducible in tests and
keeps a hallucination out of anything that affects billing.

## Auth

Auth.js (NextAuth) in the web app. Optional — the dashboard runs unauthenticated
in demo mode, and the API is designed for the mobile app's bearer token. Add
`NEXTAUTH_SECRET` and OAuth keys when you want it.

## Testing

254 tests, no network, no filesystem, no real clock.

```ts
const h = harness(new Date('2026-03-02T09:00:00.000Z'));  // pinned clock
const ctx = createContext({ repo: h.repo, events: h.events, now: h.now });
h.advance(30);   // "30 days later", exactly
```

Fixtures in `packages/core/test` are shared by every package via the
`@studiodesk/core/test` entry point. The suite includes a 32-booking fixture
across four classes and a 100-member seeded studio, so realistic flows are
covered rather than isolated units.

`tsconfig.json` typechecks source with `noUncheckedIndexedAccess` on;
`tsconfig.test.json` relaxes it for tests, where indexing a fixture array *is*
the assertion.
