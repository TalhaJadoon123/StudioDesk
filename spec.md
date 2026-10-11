# StudioDesk Specification

**Version:** 1.0.0
**Status:** Implemented
**Related:** `constitution.md`, `plan.md`, `tasks.md`, `checklist.md`

---

## 1. User Stories

### 1.1 Studio Owner (Primary Actor)

| ID | Story | Priority |
|----|-------|----------|
| US-01 | As a studio owner, I want to manage members (create, pause, resume, cancel) so I can track my roster. | P0 |
| US-02 | As a studio owner, I want to create plans (Free, Starter, Business) with limits so I can tier my offerings. | P0 |
| US-03 | As a studio owner, I want to schedule recurring classes with RRULE so I don't manually create each session. | P0 |
| US-04 | As a studio owner, I want to view a dashboard with revenue, attendance, and churn metrics so I can make decisions. | P0 |
| US-05 | As a studio owner, I want to run billing (memberships, packs, drop-ins, fees) so I get paid. | P0 |
| US-06 | As a studio owner, I want to check in members via QR, kiosk, GPS, or manual roll call so attendance is accurate. | P0 |
| US-07 | As a studio owner, I want to send invoices and track payments so my books are clean. | P0 |
| US-08 | As a studio owner, I want to configure email/payment/AI integrations when I'm ready, not before. | P1 |

### 1.2 Member (Secondary Actor)

| ID | Story | Priority |
|----|-------|----------|
| US-10 | As a member, I want to book classes and join waitlists so I get a spot. | P0 |
| US-11 | As a member, I want to see my schedule, booking history, and pack balance. | P0 |
| US-12 | As a member, I want to check in via QR code or kiosk so it's fast. | P0 |
| US-13 | As a member, I want to receive notifications (email/in-app) for bookings, cancellations, payments. | P1 |

### 1.3 Instructor (Secondary Actor)

| ID | Story | Priority |
|----|-------|----------|
| US-15 | As an instructor, I want to see my class load and roster so I'm prepared. | P1 |
| US-16 | As an instructor, I want to mark attendance manually (roll call) when tech fails. | P1 |

---

## 2. Acceptance Criteria

### 2.1 Members (US-01, US-10, US-11)

| AC ID | Criterion | Test |
|-------|-----------|------|
| AC-01 | Create member with name, email, phone, plan, tags, notes | `POST /api/members` → 201 |
| AC-02 | Member status: active, paused, cancelled | `PATCH /api/members/:id` |
| AC-03 | Plan assignment enforces limits (capacity, class types, instructors) | `assertMemberCapacity` |
| AC-04 | Pause/resume preserves history, stops billing | `POST /api/members/:id/pause` |
| AC-05 | Cancel stops future billings, preserves history | `POST /api/members/:id/cancel` |
| AC-06 | Member usage shows pack balance, drop-ins, fees | `GET /api/members/:id/usage` |

### 2.2 Plans (US-02)

| AC ID | Criterion | Test |
|-------|-----------|------|
| AC-10 | Free tier: 30 members, 1 class type, 2 instructors, no waitlist, no QR | `assertClassTypeAllowed` |
| AC-11 | Starter tier: 150 members, unlimited class types, 10 instructors, waitlist, QR | — |
| AC-12 | Business tier: unlimited everything, churn AI narratives | — |
| AC-13 | Tier enforced at studio level, not per-member | `studio.tier` |

### 2.3 Schedule & Classes (US-03, US-10)

| AC ID | Criterion | Test |
|-------|-----------|------|
| AC-20 | Create class with instructor, capacity, price, RRULE recurrence | `POST /api/classes` |
| AC-21 | RRULE expands correctly (daily, weekly, monthly, COUNT, UNTIL) | `expandRRule` tests |
| AC-22 | Conflict detection: same instructor, overlapping times | `assertNoConflict` |
| AC-23 | Capacity enforcement with waitlist auto-promotion | `createBooking` + waitlist tests |
| AC-24 | Late-cancel policy: inside `lateCancelHours` = fee + keep credit | `cancelBooking` |
| AC-25 | Staff cancel never late, always refunds | `cancelBooking(staff=true)` |

### 2.4 Bookings & Waitlists (US-10)

| AC ID | Criterion | Test |
|-------|-----------|------|
| AC-30 | Book class deducts pack credit or charges drop-in | `POST /api/bookings` |
| AC-31 | Waitlist auto-promotes on cancellation, no gaps | `promoteAndNotify` |
| AC-32 | Waitlist skips inactive/paused members | `waitlist.ts` logic |
| AC-33 | Bulk booking for packs | `POST /api/bookings/bulk` |
| AC-34 | Booking history with status (booked, attended, cancelled, no-show) | `GET /api/bookings` |

### 2.5 Check-in (US-06, US-12, US-16)

| AC ID | Criterion | Test |
|-------|-----------|------|
| AC-40 | QR ticket: `sd1.<memberId>.<nonce>.<expiry>.<hmac>` | `issueTicket` / `verifyTicket` |
| AC-41 | QR expiry invalidates signature if tampered | `checkin.ts` |
| AC-42 | GPS geofence: configurable radius, studio coordinates | `geo.ts` |
| AC-43 | Kiosk mode: tablet pairs with device ID, no auth needed | `kiosk.ts` |
| AC-44 | Manual roll call: instructor marks attended/absent | `manual.ts` |
| AC-45 | Duplicate check-in returns `duplicate_checkin` error | — |

### 2.6 Billing (US-05, US-07)

| AC ID | Criterion | Test |
|-------|-----------|------|
| AC-50 | Membership: recurring (Polar/LemonSqueezy) + manual | `subscribe` / `cancelMembership` |
| AC-51 | Class packs: N credits, expiry, prorated upgrades | `purchasePack` |
| AC-52 | Drop-ins: one-off, Stripe only | `purchaseDropIn` |
| AC-53 | Late-cancel fee: configurable hours, waivable | `assessLateCancelFee` |
| AC-54 | No-show fee: assessed on class completion | `assessNoShowFee` |
| AC-55 | Dunning: 4 stages (1d, 3d, 7d, 14d), pauses membership on final | `runDunning` |
| AC-56 | Invoice PDF generation (optional pdfme dependency) | `POST /api/invoices/:id/pdf` |
| AC-57 | Offline mode: all payments recorded as settled at desk | Mock gateway |

### 2.7 Reports & Churn (US-04)

| AC ID | Criterion | Test |
|-------|-----------|------|
| AC-60 | Revenue: daily/weekly/monthly, by plan, by class | `revenueReport` |
| AC-61 | Attendance: rates, streaks, unique members | `attendanceReport` |
| AC-62 | Churn: heuristicRisk (0-1) + signals (attendance, billing, engagement) | `heuristicRisk` |
| AC-63 | Churn AI narrative (Business only): Groq explains score + action | `enrichWithGroq` |
| AC-64 | Dashboard snapshot: KPIs + alerts | `dashboardSnapshot` |

### 2.8 Integrations (US-08)

| AC ID | Criterion | Test |
|-------|-----------|------|
| AC-70 | Supabase: optional, enabled by `NEXT_PUBLIC_SUPABASE_URL` + service key | `hasHostedBackend()` |
| AC-71 | Groq AI: optional, Business tier only, `GROQ_API_KEY` | `hasAi()` |
| AC-72 | Payments: Polar (recurring), Stripe (one-off), LemonSqueezy (alt) | `hasPayments()` |
| AC-73 | Email: Resend or useSend, in-app fallback | `resendApiKey()` / `useSendUrl()` |
| AC-74 | All integrations degrade gracefully — no hard dependency | Demo mode |

---

## 3. Non-Functional Requirements

| NFR ID | Requirement | Target |
|--------|-------------|--------|
| NFR-01 | Zero-cost deployment on free tiers | All services free |
| NFR-02 | API p99 latency | < 200 ms |
| NFR-03 | Test suite runtime | < 60 s |
| NFR-04 | Typecheck runtime | < 60 s |
| NFR-05 | Zero vulnerabilities in production deps | `npm audit --omit=dev` = 0 |
| NFR-06 | Secret scanning | 0 findings in tracked files |
| NFR-07 | Test coverage | > 80% (current: 69% — target for v1.1) |
| NFR-08 | Deterministic tests | 0 flaky (3 consecutive runs) |
| NFR-09 | CI/CD pipeline | GitHub Actions on PR + push |
| NFR-10 | Observability | Request IDs, structured logs, health probes |

---

## 4. Scope Boundaries

### In Scope (v1.0)
- Single-studio deployment
- Member management (CRUD + pause/resume/cancel)
- Plan tiers (Free/Starter/Business) with limits
- Schedule with RRULE recurrence
- Bookings with packs, drop-ins, waitlists
- Check-in: QR, GPS, kiosk, manual
- Billing: memberships, packs, drop-ins, fees, dunning
- Reports: revenue, attendance, churn (heuristic + AI)
- Invoicing with PDF
- Demo mode (no external services)
- Cloudflare Workers + Pages deployment
- Docker Compose for self-hosting

### Out of Scope (v1.0)
- Multi-studio / multi-tenancy
- Real-time WebSocket sync
- Complex RBAC (beyond staff/admin)
- White-label / theming
- Native iOS/Android (Expo web only)
- Advanced analytics / ML beyond churn
- Payroll / instructor payments
- Inventory / retail