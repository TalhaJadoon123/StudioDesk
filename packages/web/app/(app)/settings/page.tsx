import Link from 'next/link';
import { getDesk } from '@/lib/desk';
import { AppShell, PageHeader, Badge } from '@/lib/components';
import { money } from '@/lib/format';
import { PLAN_CATALOG, PLAN_ORDER, limitsForTier } from '@studiodesk/shared';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const desk = getDesk();
  const studio = await desk.studio.getStudio(desk.ctx);
  const plan = PLAN_CATALOG[studio.tier];
  const limits = limitsForTier(studio.tier);
  const settings = (studio.settings ?? {}) as Record<string, unknown>;

  const env = [
    { name: 'Supabase', ok: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL), purpose: 'Database' },
    { name: 'Groq', ok: Boolean(process.env.GROQ_API_KEY), purpose: 'Churn narratives' },
    { name: 'Polar / Lemon Squeezy', ok: Boolean(process.env.POLAR_ACCESS_TOKEN || process.env.LEMONSQUEEZY_API_KEY), purpose: 'Subscriptions' },
    { name: 'Stripe', ok: Boolean(process.env.STRIPE_SECRET_KEY), purpose: 'One-off payments' },
    { name: 'Resend / useSend', ok: Boolean(process.env.RESEND_API_KEY || process.env.USE_SEND_URL), purpose: 'Email' },
  ];

  return (
    <AppShell studioName={studio.name} tier={studio.tier}>
      <PageHeader title="Settings" subtitle={`${plan.name} plan - ${studio.timezone}`} />

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h3>Studio</h3>
          </div>
          <div className="card-pad">
            <table className="table">
              <tbody>
                <tr>
                  <td>Name</td>
                  <td>{studio.name}</td>
                </tr>
                <tr>
                  <td>Timezone</td>
                  <td>{studio.timezone}</td>
                </tr>
                <tr>
                  <td>Currency</td>
                  <td>{studio.currency.toUpperCase()}</td>
                </tr>
                <tr>
                  <td>Check-in geofence</td>
                  <td>
                    {studio.checkinGeofence
                      ? `${studio.checkinGeofence.radiusMeters}m around ${studio.checkinGeofence.latitude.toFixed(4)}, ${studio.checkinGeofence.longitude.toFixed(4)}`
                      : 'not set - check-in by QR only'}
                  </td>
                </tr>
                <tr>
                  <td>Late cancel window</td>
                  <td>{String(settings.lateCancelHours ?? 4)} hours</td>
                </tr>
                <tr>
                  <td>Late cancel fee</td>
                  <td>{money(Number(settings.lateCancelFeeCents ?? 300))}</td>
                </tr>
                <tr>
                  <td>No-show fee</td>
                  <td>{money(Number(settings.noShowFeeCents ?? 500))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Integrations</h3>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Used for</th>
                <th className="right">Status</th>
              </tr>
            </thead>
            <tbody>
              {env.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td className="tiny muted">{row.purpose}</td>
                  <td className="right">
                    {row.ok ? <Badge tone="ok">connected</Badge> : <Badge tone="neutral">offline mode</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card mt-4">
        <div className="card-head">
          <h3>Plan</h3>
          <Badge tone="info">{plan.name}</Badge>
        </div>
        <div className="card-pad">
          <div className="grid grid-4">
            <div>
              <div className="stat-label">Members</div>
              <div className="stat-value">{limits.maxMembers ?? '∞'}</div>
            </div>
            <div>
              <div className="stat-label">Class types</div>
              <div className="stat-value">{limits.maxClassTypes ?? '∞'}</div>
            </div>
            <div>
              <div className="stat-label">Instructors</div>
              <div className="stat-value">{limits.maxInstructors ?? '∞'}</div>
            </div>
            <div>
              <div className="stat-label">Seats</div>
              <div className="stat-value">{limits.seats}</div>
            </div>
          </div>
          <div className="row wrap mt-4">
            {limits.waitlist ? <Badge tone="ok">waitlists</Badge> : <Badge tone="neutral">no waitlists</Badge>}
            {limits.qrCheckin ? <Badge tone="ok">QR check-in</Badge> : null}
            {limits.churnAi ? <Badge tone="ok">churn AI</Badge> : null}
            {limits.dunning ? <Badge tone="ok">dunning</Badge> : null}
            {limits.kioskMode ? <Badge tone="ok">kiosk</Badge> : null}
            {limits.apiAccess ? <Badge tone="ok">API access</Badge> : null}
          </div>
          <div className="mt-4">
            <Link href="/pricing" className="btn">
              Change plan
            </Link>
          </div>
        </div>
      </section>

      <section className="card mt-4">
        <div className="card-head">
          <h3>Data</h3>
        </div>
        <div className="card-pad">
          <p className="muted tiny mt-0">
            Everything is yours. Export the whole studio as JSON, or reset to the demo data set.
          </p>
          <div className="row">
            <Link className="btn btn-sm" href="/api/export">
              Export JSON
            </Link>
            <Link className="btn btn-sm" href="/api/health">
              API health
            </Link>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
