# StudioDesk — operational runbook

One page: what StudioDesk does, where the data lives, what fails when, and how
to fix it.

## The 30-second version

```bash
npm install && npm run seed:demo
npm run dev:api      # :4000
npm run dev:web      # :3000
```

No keys, no database, fully functional. Every integration degrades to an
offline equivalent and the health endpoint tells you which mode you are in:

```bash
curl -s localhost:4000/health | jq
```

## Data model in one diagram

```
Studio ─┬─ Plan ──────► Membership ──► Invoice ──► Charge
        ├─ Member ─┬─ Booking ──────► Class
        │          ├─ Attendance
        │          ├─ ClassPack
        │          ├─ DropIn
        │          ├─ Fee
        │          └─ Notification
        └─ Instructor ──► Class
```

Member-facing plans live in `plans` and are studio-scoped. Platform plans (free
/ Starter / Business) live on the `studios.tier` column and are not rows.

## Everything is cents

There are no floats anywhere near money. `formatMoney(3900)` is `$39.00`.
If you add a price, store it as an integer of cents.

## Plan limits and where they are enforced

| Limit            | Free   | Starter | Business | Enforced in                     |
|------------------|--------|---------|----------|----------------------------------|
| Active members   | 30     | 150     | ∞        | `assertMemberCapacity` (core)    |
| Class types      | 1      | ∞       | ∞        | `assertClassTypeAllowed` (core)  |
| Instructors      | 2      | 10      | ∞        | `createInstructor` (core)        |
| Waitlists        | ✗      | ✓       | ✓        | `createBooking` (core)          |
| QR check-in      | ✗      | ✓       | ✓        | `assertFeature` (core)           |
| Churn AI         | ✗      | ✗       | ✓        | `enrichWithGroq` (churn)         |
| Smart dunning    | ✗      | ✗       | ✓        | `getDunningPolicy` (billing)    |
| Kiosk mode       | ✗      | ✗       | ✓        | kiosk routes                     |

Limits are checked in the service layer, not the UI, so the API and the web app
cannot bypass them.

## Booking lifecycle

```
        book (spots free)          full + allowWaitlist
  ────────────────────────────▶  booked ──────────────▶ waitlisted (position n)
        │                              │                       │
        │ cancel (early) ──┐           │ cancel ────────────────┘
        │                  ▼           ▼            (promotes the next in line,
        │            cancelled ◀───────┘              resequences the queue,
        │                  │                          notifies everyone promoted)
        │                  │ class cancelled
        │                  ▼
        │            (all bookings cancelled, fees waived)
        │
        └─ cancel (late, inside lateCancelHours)
                     ▼
              credit consumed + late-cancel fee
```

Waitlisted members who are no longer active are skipped rather than promoted
into a spot they cannot use.

## Dunning state machine

Driven by `runDunning()`, on a cron or the Workers trigger.

```
day 0   payment fails → membership past_due, member notified
day 1   retry 1
day 3   retry 2
day 5   retry 3
day 7   pause membership for 30 days
day 21  cancel
```

Every stage is anchored to the **timestamp of the first failure**, not the
billing period end. `dunningStage` records the last step attempted, so
re-running dunning is idempotent. A successful retry clears the state and
resumes the member automatically.

## Failure modes and what you will see

| Symptom                              | Cause                                    | Fix                                              |
|--------------------------------------|------------------------------------------|--------------------------------------------------|
| `/health` says `"driver":"memory"`   | No Supabase keys                         | Set `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, run `npm run schema:print` |
| `"payments":false`                   | No gateway keys                          | Expected offline mode. Add Polar for subscriptions |
| Waitlist returns 409 `class_full`    | Class is full                            | Retry with `allowWaitlist: true`                  |
| Waitlist returns 403                 | Studio is on the Free plan               | Upgrade — waitlists start on Starter              |
| Check-in returns `outside-geofence`  | Member is not within the studio radius   | Widen `checkinGeofence.radiusMeters`, or use QR   |
| QR check-in says "expired"           | Ticket older than 120 s                  | Tap "refresh code" in the app — tickets are short-lived by design |
| Webhook returns 401                  | Signature mismatch                       | Check the webhook secret and that you are reading the **raw** body |
| Webhook returns 503                  | Webhook secret not configured            | `wrangler secret put POLAR_WEBHOOK_SECRET`        |
| Churn explanations look templated    | No `GROQ_API_KEY`, or not on Business    | Heuristic explanations are always present; Groq adds prose |
| Dunning never fires                  | No cron configured                       | `POST /api/billing/dunning/run`, or set the Workers trigger |

## Data safety

- **Money is never mutated in place.** Cancelling a charge creates a refund
  record; the original stays.
- **Fees are idempotent per booking.** `booking.cancelled` and
  `class.completed` both fire for the same booking — the second is a no-op.
- **Charges are idempotent per logical operation.** Every payment carries an
  `sd_<kind>_<member>_<reference>` key, so a retried webhook or a double tap
  cannot double-charge.
- **Deleting a member keeps the financial history** and removes the PII row.
- **Export everything** from `/api/export` before any plan change or migration.

## Security notes

- Unverified webhooks are refused, not trusted — an unsigned call can never mark
  a membership paid.
- 5xx errors return a generic message; details are logged, never sent.
- QR tickets are HMAC-signed and short-lived, so a screenshot stops working.
- Supabase RLS is enabled and locked to the service role; only the server touches
  the table.
- Refunds and plan changes are staff actions; the kiosk can only check people in.

## Performance

- Every repository query goes through one `Table<T>` interface, so the memory
  and Supabase drivers are drop-in replacements.
- Pages are server components. The only client JS is the form posts.
- The API is stateless: scale it to zero between requests.
- Reports cap the day series at 400 entries, so a bad date range cannot
  allocate unbounded memory.

## Extending it

| Want to…                        | Where                                        |
|----------------------------------|----------------------------------------------|
| Add a field                     | `packages/shared/src/types.ts`, then the repository is schemaless — just add it |
| Change pricing                  | `packages/shared/src/plans.ts` (one place)    |
| Add a report                    | `packages/core/src/reports.ts`                |
| Change late-cancel policy       | `studios.settings` (`lateCancelHours`, `lateCancelFeeCents`) |
| Support another payment gateway | Implement `PaymentGateway` in `packages/billing/src/gateway.ts` |
| Add a mobile screen             | `packages/mobile/app/(tabs)/`                 |
| Change churn scoring             | `heuristicRisk()` in `packages/core/src/members.ts` |

The Supabase driver stores entities as JSONB, so new fields need no migration.
