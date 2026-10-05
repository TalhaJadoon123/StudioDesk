// StudioDesk

Memberships, class booking and billing for small gyms and studios.

```bash
npm install          # install the backend + API dependencies
npm test             # 254 tests
npm run seed:demo    # a 100-member yoga studio, 8 weeks of history
npm run dev:api      # http://localhost:4000
npm run dev:web      # http://localhost:3000  (needs: npm run setup:web)
```

Everything runs with **no API keys and no database**. The app boots against an
in-memory repository and every integration degrades gracefully. Add credentials
when you want them - see [Manual steps](#manual-steps).

## What it does

- **Members** - roster, plans, attendance history, balances, churn scoring
- **Schedule** - RRULE recurring classes, week/month grid, conflict detection
- **Bookings** - capacity, credits, waitlists that auto-promote on cancellation
- **Check-in** - QR codes, GPS geofencing, kiosk/tablet mode, manual roll call
- **Billing** - memberships, class packs, drop-ins, late-cancel and no-show fees,
  invoices with PDF, smart dunning
- **Reports** - revenue, attendance, churn

## Packages

| Package      | What lives there                                        |
|--------------|---------------------------------------------------------|
| `shared`     | Types, money/date helpers, plan catalog, event bus      |
| `core`       | Repository abstraction, members, classes, bookings, attendance, churn, reports, Supabase driver, demo seed |
| `booking`    | RRULE, calendar grids, waitlist orchestration, instructor load |
| `billing`    | Gateways (Stripe/Polar/LemonSqueezy/manual/mock), invoices, packs, drop-ins, fees, dunning, PDF |
| `checkin`    | QR tickets, geofencing, kiosk pairing, roll call        |
| `api`        | Fastify HTTP API + a Cloudflare Workers entrypoint      |
| `web`        | Next.js dashboard and marketing site                    |
| `mobile`     | Expo app (schedule, bookings, check-in, passes)         |
| `docs`       | This documentation                                     |

Every package ships TypeScript source directly (`main` points at `src/index.ts`),
so there is no build step and no stale `dist`. `tsx` runs it in development,
Next transpiles it, and Wrangler bundles it for Workers.

## Architecture

```
packages/web (Next.js, port 3000)  ──┐
packages/mobile (Expo)             ─┼──▶ packages/api (Fastify, port 4000)
packages/web server components    ──┘         │
                                                 ▼
                                        packages/core ──▶ Repository
                                             │            ├─ MemoryRepository (default)
                                             │            └─ SupabaseRepository (free tier)
                                             ▼
                            booking · billing · checkin
```

One implementation of every rule. The API, the web server components and the
tests all call the same functions, so behaviour cannot drift between them.

The repository is the only thing that knows where data lives:

```ts
const desk = await createStudioDesk();     // Supabase if configured, else memory
await desk.members.createMember(desk.ctx, { name: 'Ada' });
```

## Domain rules worth knowing

**Money is always integer cents.** `formatMoney(3900) === '$39.00'`. There are
no floats anywhere near a price.

**Cancellation has three outcomes.** Early cancel refunds the class credit.
Late cancel (inside the studio's `lateCancelHours`, default 4) keeps the credit
and assesses a fee. Staff cancels are never late.

**Waitlists promote on every cancellation.** The queue is renumbered to have no
gaps, members who are no longer active are skipped, and everyone promoted is
notified. See `packages/booking/src/waitlist.ts`.

**The free tier enforces one class type.** Two "Vinyasa" classes on different
days are one type; "Vinyasa" and "Restorative" are two.

**Churn scoring is deterministic first.** `heuristicRisk()` always runs and
produces the 0..1 score plus a signal breakdown. Groq (Business plan only) then
writes the explanation and next action. The model never changes the number -
that keeps results reproducible and keeps a hallucination out of billing logic.

**QR tickets are short-lived and signed.** `sd1.<memberId>.<nonce>.<expiry>.<hmac>`.
Changing any field, including the expiry, invalidates the signature.

## Testing

```bash
npm test              # 254 tests across 15 files
npm run typecheck     # source
npm run typecheck:all # source + tests
npm run test:coverage
```

Tests use a pinned clock (`packages/core/test/fixtures.ts`) and the in-memory
repository, so nothing touches the network or the filesystem. Payments are
tested against `createMockGateway()`, which records every call and can fail on
demand:

```ts
const gateway = createMockGateway();
gateway.failNext('card_declined');   // one decline
gateway.failAlways('card_declined'); // a dead card, for dunning tests
```

The suite includes a 32-booking fixture across four classes (open, nearly full,
sold out with a six-deep waitlist, and a finished class) and a 100-member seeded
studio.

## Bugs this suite caught

Worth listing, because they are the reason the tests exist:

- `assertBookable` read `Date.now()` instead of the injected clock, so any class
  more than an hour in the future looked like it had already started
- The repository filter language only supported one operator per object, so
  `{$gte, $lte}` range queries silently returned nothing
- `cheapestGateway()` sorted by net payout ascending - it selected the *most*
  expensive processor
- The dunning runner anchored its retry schedule to `currentPeriodEnd`, a month
  out, so dunning never fired; the first failure also consumed stage 0, skipping
  the day-1 retry
- `parseRRule` split only on `;`, so the RFC-standard `DTSTART:` line was
  unreadable and every rule threw
- `expandRRule` dropped past occurrences from the `COUNT` tally, and monthly
  rules drifted because the day-of-month was never re-applied after stepping
  months
- The roll call filtered out `attended` members, hiding everyone who had already
  checked in
- QR ticket expiry used wall-clock time rather than the studio's clock

## Deploying for $0

See [DEPLOY.md](./DEPLOY.md) for the full walkthrough. Short version:

- **Web** - Cloudflare Pages (free, unlimited bandwidth)
- **API** - Cloudflare Workers free tier, or any Node host
- **Database** - Supabase free (500 MB)
- **Domain** - EU.org, free, or `pages.dev` for free
- **AI** - Groq free tier for churn narratives
- **Email** - Resend free (3,000/month) or self-hosted useSend
- **Payments** - Polar or Lemon Squeezy; you only pay per-transaction, no
  monthly fee

## Manual steps

Things that need your account and cannot be done from here:

1. **Copy the environment file**: `cp .env.example .env`
2. **Create a Supabase project** and run the SQL from `npm run schema:print`
3. **Get an Auth.js secret**: `openssl rand -base64 32`
4. **Create a Polar account** and two products ($39 Starter, $99 Business)
5. **Optional**: Stripe key for one-off payments, Groq key for churn AI,
   Resend key for email
6. **Deploy** - `npm run deploy:pages` and `npm run deploy:worker`

Every one of these is optional. The app is fully functional without them.

## License

MIT.
