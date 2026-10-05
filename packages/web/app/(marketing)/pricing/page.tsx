import Link from 'next/link';
import { PLAN_CATALOG, PLAN_ORDER, formatMoney, type CatalogPlan } from '@studiodesk/shared';

const plan = (tier: (typeof PLAN_ORDER)[number]): CatalogPlan => PLAN_CATALOG[tier];

export const metadata = {
  title: 'Pricing',
  description: 'Free for one class type. $39/mo Starter. $99/mo Business. No per-member fee.',
};

/** Comparison table. Plain data, no client JS. */

const ROWS: Array<{ label: string; get: (plan: CatalogPlan) => string | boolean }> = [
  { label: 'Active members', get: (p) => (p.limits.maxMembers === null ? 'Unlimited' : String(p.limits.maxMembers)) },
  { label: 'Class types', get: (p) => (p.limits.maxClassTypes === null ? 'Unlimited' : String(p.limits.maxClassTypes)) },
  { label: 'Instructors', get: (p) => (p.limits.maxInstructors === null ? 'Unlimited' : String(p.limits.maxInstructors)) },
  { label: 'Waitlists with auto-promotion', get: (p) => p.limits.waitlist },
  { label: 'QR check-in + mobile app', get: (p) => p.limits.qrCheckin },
  { label: 'Class packs, drop-ins & fees', get: (p) => p.tier !== 'free' },
  { label: 'Branded PDF invoices', get: (p) => p.limits.customBranding },
  { label: 'Churn prediction (Groq AI)', get: (p) => p.limits.churnAi },
  { label: 'Smart dunning & recovery', get: (p) => p.limits.dunning },
  { label: 'Kiosk / tablet mode', get: (p) => p.limits.kioskMode },
  { label: 'Open API + webhooks', get: (p) => p.limits.apiAccess },
  { label: 'Seats', get: (p) => String(p.limits.seats) },
  { label: 'Report history', get: (p) => `${p.limits.reportRetentionDays} days` },
];

function cell(value: string | boolean) {
  if (typeof value === 'string') return <td className="num">{value}</td>;
  return (
    <td className="center">
      {value ? (
        <span className="check" aria-label="included">
          ✓
        </span>
      ) : (
        <span className="muted-2" aria-label="not included" style={{ color: 'var(--muted-2)' }}>
          –
        </span>
      )}
    </td>
  );
}

export default function PricingPage() {
  return (
    <div className="marketing">
      <nav className="marketing-nav">
        <Link href="/" className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">S</span>
          StudioDesk
        </Link>
        <Link href="/dashboard" className="btn btn-sm btn-primary">
          Open the app
        </Link>
      </nav>

      <section className="section">
        <div className="center" style={{ marginBottom: 32 }}>
          <h1 style={{ marginBottom: 8 }}>Simple pricing</h1>
          <p className="muted" style={{ maxWidth: 560, margin: '0 auto' }}>
            Priced per studio, not per member. Your members never see a StudioDesk fee. Upgrade or
            downgrade whenever you like - the data stays put.
          </p>
        </div>

        <div className="pricing-grid">
          {PLAN_ORDER.map((tier) => {
            const selected = plan(tier);
            return (
              <div className={`price-card${selected.highlighted ? ' featured' : ''}`} key={tier}>
                {selected.highlighted ? <span className="price-badge">Most popular</span> : null}
                <h3>{selected.name}</h3>
                <div className="price-amount">
                  {formatMoney(selected.priceCents)}
                  <span>/month</span>
                </div>
                <p className="muted tiny">
                  {selected.priceCents === 0
                    ? 'Free forever, no card required'
                    : `${formatMoney(selected.yearlyPriceCents)} billed yearly (2 months free)`}
                </p>
                <p className="muted tiny">{plan.tagline}</p>
                <div className="mt-4">
                  <Link
                    href={tier === 'free' ? '/dashboard' : `/dashboard?plan=${tier}`}
                    className={`btn ${plan.highlighted ? 'btn-primary' : ''}`}
                    style={{ width: '100%' }}
                  >
                    {tier === 'free' ? 'Start free' : `Choose ${plan.name}`}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section section-alt">
        <div className="section-inner">
          <h2 className="mb-4">What is in each plan</h2>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ minWidth: 220 }}>Feature</th>
                  {PLAN_ORDER.map((tier) => (
                    <th key={tier} className="center">
                      {plan(tier).name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {PLAN_ORDER.map((tier) => {
                      const selected = plan(tier);
                      return <td key={tier}>{cell(row.get(selected))}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="grid grid-2">
          <div className="card card-pad">
            <h3>Money and fees</h3>
            <p className="muted tiny mt-2">
              StudioDesk charges a flat monthly fee. Card processing is passed through at cost:
              Stripe 2.9% + 30c for one-off payments, Polar 4% + 40c for subscriptions, or Lemon Squeezy
              where that works better. With no payment keys configured, everything runs in offline mode
              and you record cash and bank transfers by hand.
            </p>
          </div>
          <div className="card card-pad">
            <h3>What it costs to run</h3>
            <p className="muted tiny mt-2">
              Supabase free (500 MB), Cloudflare Pages + Workers free, Groq free tier, Resend free
              (3,000 emails/month) and an EU.org domain. A single-studio deployment runs at $0 per month.
            </p>
          </div>
        </div>
      </section>

      <footer className="footer">StudioDesk - MIT licensed.</footer>
    </div>
  );
}
