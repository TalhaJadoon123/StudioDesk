import Link from 'next/link';
import { getDesk } from '@/lib/desk';
import { Badge } from '@/lib/components';

export const metadata = {
  title: 'Studio Health Check',
  description: 'A free read on your attendance, fill rate and no-shows - with the three things worth fixing first.',
};
export const dynamic = 'force-dynamic';

const TONE = {
  pass: { badge: 'ok' as const, label: 'Healthy' },
  warn: { badge: 'warn' as const, label: 'Watch this' },
  fail: { badge: 'danger' as const, label: 'Needs work' },
};

const GRADE_TONE = {
  A: 'ok',
  B: 'info',
  C: 'warn',
  D: 'danger',
} as const;

/**
 * The free lead magnet. Reads the demo/live studio data and reports the three
 * highest-leverage fixes. No signup, no email gate.
 */
export default async function HealthCheckPage() {
  const desk = getDesk();
  const health = await desk.reports.studioHealthCheck(desk.ctx);
  const studio = await desk.studio.getStudio(desk.ctx);

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
        <div className="grid grid-2" style={{ alignItems: 'start' }}>
          <div>
            <Badge tone={GRADE_TONE[health.grade]}>{health.grade} grade</Badge>
            <h1 style={{ margin: '14px 0 10px' }}>Your Studio Health Check</h1>
            <p className="muted" style={{ fontSize: 17 }}>
              {health.headline}
            </p>
            <p className="muted tiny">
              Based on the last 30 days of {studio.name}. Five checks, scored and weighted by how much
              revenue they usually protect.
            </p>
          </div>

          <div className="card card-pad center">
            <div
              className="score-ring"
              style={{
                width: 108,
                height: 108,
                fontSize: 34,
                margin: '0 auto 12px',
                background: 'var(--accent-weak)',
                color: 'var(--accent-strong)',
              }}
            >
              {health.score}
            </div>
            <div className="muted tiny">out of 100</div>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="card">
          {health.checks.map((check) => {
            const tone = TONE[check.status];
            return (
              <div
                className="row-between card-pad"
                key={check.label}
                style={{ borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}
              >
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <Badge tone={tone.badge}>{tone.label}</Badge>
                  <div className="stack">
                    <span style={{ fontWeight: 500 }}>{check.label}</span>
                    <span className="tiny muted">{check.detail}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {health.recommendations.length > 0 ? (
        <section className="section" style={{ paddingTop: 0 }}>
          <h2 className="mb-4">Do these first</h2>
          <div className="grid grid-3">
            {health.recommendations.map((recommendation, index) => (
              <div className="card card-pad" key={recommendation}>
                <div className="feature-icon">{index + 1}</div>
                <p className="mt-0">{recommendation}</p>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="section" style={{ paddingTop: 0 }}>
          <div className="card card-pad center">
            <p className="mt-0">Nothing needs fixing right now. Keep the streak going.</p>
          </div>
        </section>
      )}

      <section className="section section-alt">
        <div className="section-inner center">
          <h2>See the numbers behind this</h2>
          <p className="muted" style={{ maxWidth: 520, margin: '8px auto 20px' }}>
            StudioDesk shows you exactly where each of these comes from - per class, per instructor,
            per member - and nudges you when something needs attention.
          </p>
          <Link href="/dashboard" className="btn btn-lg btn-primary">
            Open StudioDesk free
          </Link>
        </div>
      </section>

      <footer className="footer">StudioDesk - MIT licensed.</footer>
    </div>
  );
}
