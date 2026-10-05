# Deploying StudioDesk for $0

Every service below has a free tier that is genuinely free, not a trial. A
single-studio deployment costs nothing per month until you exceed them.

| Need            | Service                | Free allowance                          |
|-----------------|------------------------|-----------------------------------------|
| Web (Next.js)   | Cloudflare Pages       | Unlimited bandwidth, 500 builds/month   |
| API             | Cloudflare Workers     | 100,000 requests/day                    |
| Database        | Supabase               | 500 MB, 1 GB storage, 5 GB egress/month |
| AI (churn)      | Groq                   | Generous free tier                       |
| Email           | Resend (or useSend)    | 3,000 emails/month                       |
| Subscriptions   | Polar or Lemon Squeezy | No monthly fee, per-transaction only     |
| One-off payments| Stripe                 | No monthly fee, 2.9% + 30c               |
| Domain          | EU.org or `pages.dev`  | Free                                     |
| Uptime          | UptimeFlare            | Free                                     |

## 1. Local first

```bash
npm install
npm run seed:demo
npm run dev:api
```

Open http://localhost:4000/health. You should see `"driver":"memory"` and
`"payments":false`. That is the fully functional demo - nothing else is needed
to evaluate the product.

## 2. Database (optional but recommended)

Without Supabase your data lives in memory and disappears when the process
restarts. To persist it:

1. Create a free project at https://supabase.com
2. SQL Editor -> New query, and paste the output of:

   ```bash
   npm run schema:print
   ```

3. Copy the two keys from Project Settings -> API:

   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```

4. Restart. `/health` should now report `"supabase":true`, `"driver":"supabase"`.

StudioDesk stores each entity as one JSONB row in a single `records` table. The
free tier stays small, migrations stay boring, and onboarding a new studio needs
no DDL at all. Row Level Security is enabled and locked to the service role -
only the server ever touches this table.

## 3. Auth (optional)

The dashboard works without login in demo mode. To add Auth.js:

```bash
openssl rand -base64 32     # NEXTAUTH_SECRET
```

```env
NEXTAUTH_URL=https://your-domain.pages.dev
NEXTAUTH_SECRET=<the random string>
```

Add Google or GitHub OAuth keys if you want social login; the credentials
provider (`ALLOW_EMAIL_LOGIN=true`) needs no external account.

## 4. Payments

StudioDesk uses two gateways on purpose:

- **Polar or Lemon Squeezy** for the $39/$99 recurring subscriptions.
  Polar is open source and charges 4% + 40c. Lemon Squeezy is the friendlier
  option in Pakistan. Both have no monthly fee.
- **Stripe** for one-off charges: class packs, drop-ins, late-cancel and
  no-show fees. Stripe's recurring billing is deliberately unused.

```env
RECURRING_GATEWAY=polar
POLAR_ACCESS_TOKEN=polar_oat_...
POLAR_WEBHOOK_SECRET=...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

With no keys set, billing runs in **offline mode**: invoices and memberships
are recorded in-app and payments are treated as settled at the desk. This is
useful for cash-and-bank-transfer studios and means you can test the whole flow
before signing up for anything.

All gateway adapters talk to the REST API over `fetch` rather than importing an
SDK. That keeps the package dependency-free and lets the same code run on
Workers.

## 5. Groq churn AI (optional, Business plan)

```env
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
```

Without a key, churn scoring still works - `heuristicRisk()` computes the score
and the signal breakdown. Groq only writes the explanation and the suggested
next action. It runs on the Business plan only.

## 6. Email (optional)

```env
RESEND_API_KEY=re_...
EMAIL_FROM="Your Studio <hello@yourdomain.eu.org>"
```

Or self-host [useSend](https://usesend.com) and point at it:

```env
USE_SEND_URL=https://smtp.yourdomain.eu.org
USE_SEND_TOKEN=...
```

With neither set, notifications are recorded and shown in-app rather than sent.

## 7. Deploy

### Web (Cloudflare Pages)

```bash
npm run setup:web
cd packages/web
npx wrangler pages deploy .next --project-name studiodesk
```

Build settings in the Pages dashboard:

- Build command: `npm run build`
- Build output directory: `.next`
- Root directory: `packages/web`

### API (Cloudflare Workers)

```bash
npx wrangler login
npx wrangler secret put SUPABASE_URL --config packages/api/wrangler.toml
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config packages/api/wrangler.toml
npx wrangler deploy --config packages/api/wrangler.toml
```

The worker exposes the same routes as the Node server and already has a cron
trigger (`0 3 * * *`) for renewals and dunning.

### Or Docker, anywhere

```bash
docker compose up -d
docker compose exec api npm run seed:demo
```

## 8. Domain (free)

- `pages.dev` / `workers.dev` come free with Cloudflare
- [EU.org](https://nic.eu.org) gives a real domain for free - approval takes
  days to weeks, so start on `pages.dev` and point a custom domain later

## 9. Monitoring

UptimeFlare is free and needs no account wiring in StudioDesk - add
`UPTIMEFLARE_API_KEY` if you want alerts, or point any external monitor at
`/api/health`, which reports driver, integrations and uptime:

```bash
curl -s https://your-api.workers.dev/health | jq
```

## Cost control checklist

- Members under 150 and classes under 8 per day need **no** paid tier of anything
- Put static assets on Pages (free) and keep the Worker under 100k requests/day
- Enable churn AI only on the Business plan - Groq calls are the one thing that
  scales with your member count
- Export JSON from `/api/export` before any plan change
