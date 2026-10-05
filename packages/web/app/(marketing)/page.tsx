import Link from 'next/link';
import { PLAN_CATALOG, PLAN_ORDER, formatMoney } from '@studiodesk/shared';

export const metadata = {
  title: 'StudioDesk - memberships, booking and billing for studios',
  description:
    'One system for memberships, class booking, waitlists, check-in and billing. Free for one class type.',
};

/** Marketing page. Static, cacheable at the edge, zero data fetching. */

const FEATURES = [
  {
    icon: '📅',
    title: 'Scheduling that thinks',
    body: 'Recurring classes with RRULE, drag-and-drop weeks, instructor conflict detection and one-click cancellation of a whole series.',
  },
  {
    icon: '⏳',
    title: 'Waitlists that just work',
    body: 'Members join a queue when a class fills. The moment someone cancels, the next person is confirmed and notified automatically.',
  },
  {
    icon: '💳',
    title: 'Billing without surprises',
    body: 'Memberships, class packs, drop-ins, late-cancel and no-show fees. Smart dunning recovers most failed payments quietly.',
  },
  {
    icon: '📱',
    title: 'Check-in that is not a queue',
    body: 'QR codes, geofencing, a tablet kiosk mode and a plain manual list for the front desk. Every path records attendance.',
  },
  {
    icon: '📈',
    title: 'Know who is about to leave',
    body: 'Churn scoring runs on real attendance patterns. On Business, Groq turns the numbers into a message you can actually send.',
  },
  {
    icon: '⚡',
    title: 'Honest integrations',
    body: 'Stripe for one-off payments, Polar or Lemon Squeezy for subscriptions, Supabase for the database. Nothing exotic.',
  },
];

const PROOF = [
  { stat: '0', label: 'spreadsheets to maintain' },
  { stat: '2 min', label: 'to set up a class' },
  { stat: 'Free', label: 'for one class type, forever' },
];

export default function MarketingPage() {
  return (
    <div className="marketing">
      <nav className="marketing-nav">
        <Link href="/" className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">S</span>
          StudioDesk
        </Link>
        <div className="row">
          <Link href="/pricing" className="btn btn-sm">
            Pricing
          </Link>
          <Link href="/dashboard" className="btn btn-sm btn-primary">
            Open the app
          </Link>
        </div>
      </nav>

      <header className="hero">
        <h1>Memberships, booking, and billing. One system. Real support.</h1>
        <p>
          Built for small gyms and studios that outgrew a spreadsheet but do not want an enterprise
          platform. Start free, upgrade when the waitlist becomes a problem.
        </p>
        <div className="hero-actions">
          <Link href="/dashboard" className="btn btn-lg btn-primary">
            Start free
          </Link>
          <Link href="/health-check" className="btn btn-lg">
            Run a free Studio Health Check
          </Link>
        </div>
      </header>

      <section className="section">
        <div className="grid grid-3">
          {PROOF.map((item) => (
            <div className="card card-pad center" key={item.label}>
              <div className="stat-value">{item.stat}</div>
              <div className="stat-meta">{item.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="section section-alt">
        <div className="section-inner">
          <h2 className="center" style={{ marginBottom: 8 }}>
            Everything a studio actually needs
          </h2>
          <p className="muted center" style={{ marginBottom: 28 }}>
            Not a CRM, not a payroll tool, not an analytics platform.
          </p>
          <div className="feature-grid">
            {FEATURES.map((feature) => (
              <div className="feature" key={feature.title}>
                <div className="feature-icon" aria-hidden>
                  {feature.icon}
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="row-between mb-4" style={{ flexWrap: 'wrap' }}>
          <div>
            <h2>Pricing you can predict</h2>
            <p className="page-sub">
              Per studio, not per member. Cancel whenever you like.
            </p>
          </div>
          <Link href="/pricing" className="btn">
            Compare plans
          </Link>
        </div>

        <div className="pricing-grid">
          {PLAN_ORDER.map((tier) => {
            const plan = PLAN_CATALOG[tier];
            return (
              <div
                className={`price-card${plan.highlighted ? ' featured' : ''}`}
                key={tier}
              >
                {plan.highlighted ? <span className="price-badge">Most popular</span> : null}
                <h3>{plan.name}</h3>
                <div className="price-amount">
                  {formatMoney(plan.priceCents)}
                  <span>/month</span>
                </div>
                <p className="muted tiny">{plan.tagline}</p>
                <ul className="price-list">
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <span className="check" aria-hidden>
                        ✓
                      </span>
                      {feature}
                    </li>
                  ))}
                </ul>
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
        <div className="section-inner center">
          <h2>Try it against your real schedule</h2>
          <p className="muted" style={{ maxWidth: 520, margin: '8px auto 20px' }}>
            The free Studio Health Check reads your attendance, fill rate and no-shows, then tells you
            the three things worth fixing first. No signup required.
          </p>
          <Link href="/health-check" className="btn btn-lg btn-primary">
            Run the health check
          </Link>
        </div>
      </section>

      <footer className="footer">
        <div>StudioDesk - MIT licensed. Built on free and open-source infrastructure.</div>
      </footer>
    </div>
  );
}
