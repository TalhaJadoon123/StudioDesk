import Link from 'next/link';
import { getDesk } from '@/lib/desk';
import { time, pct } from '@/lib/format';

/**
 * Kiosk / tablet mode.
 *
 * A claimed tablet lands here. No login, no sidebar - just today's classes and
 * a tap-to-check-in list. Intended for an iPad on the front desk.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { deviceId: string } }) {
  return { title: 'Kiosk' };
}

export default async function KioskPage({ params }: { params: { deviceId: string } }) {
  const desk = getDesk();
  const { kioskLanding, kioskMemberSearch } = await import('@studiodesk/checkin');

  let landing: Awaited<ReturnType<typeof kioskLanding>> | null = null;
  let error: string | null = null;
  try {
    landing = await kioskLanding(desk.ctx, params.deviceId);
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown device';
  }

  const members = await kioskMemberSearch(desk.ctx, '');

  if (error || !landing) {
    return (
      <main style={{ padding: 40, fontFamily: 'var(--font)' }}>
        <h1>Kiosk not paired</h1>
        <p style={{ color: 'var(--muted)' }}>{error}</p>
        <p className="muted tiny">
          Open Settings in StudioDesk and type the code shown on this tablet.
        </p>
        <Link href="/dashboard" className="btn">
          Back to the dashboard
        </Link>
      </main>
    );
  }

  const classes = landing.classes;

  return (
    <main style={{ padding: 24, fontFamily: 'var(--font)', background: 'var(--bg)', minHeight: '100vh' }}>
      <header className="row-between mb-4">
        <div>
          <h1 style={{ marginBottom: 2 }}>Check in</h1>
          <p className="muted tiny" style={{ margin: 0 }}>
            {landing.device.name}
            {landing.device.location ? ` - ${landing.device.location}` : ''}
          </p>
        </div>
        <span className="badge info">Kiosk mode</span>
      </header>

      <div className="grid grid-2">
        <section>
          <h2 style={{ fontSize: 16, marginBottom: 10 }}>Today&apos;s classes</h2>
          {classes.length === 0 ? (
            <div className="card card-pad center muted">No classes today.</div>
          ) : (
            classes.map((klass) => (
              <div
                className="card card-pad"
                key={klass.classId}
                style={klass.classId === landing.defaultClassId ? { borderColor: 'var(--accent)' } : undefined}
              >
                <div className="row-between">
                  <div>
                    <div className="row" style={{ gap: 10 }}>
                      <span style={{ fontSize: 20, fontWeight: 600 }} className="mono">
                        {klass.timeLabel}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 17 }}>{klass.name}</span>
                    </div>
                    <div className="muted tiny mt-2">
                      {klass.confirmed}/{klass.capacity} booked
                      {klass.waitlisted > 0 ? ` · ${klass.waitlisted} waiting` : ''}
                    </div>
                  </div>
                  {klass.isFull ? <span className="badge warn">full</span> : null}
                </div>
                <form action="/api/actions" method="post" className="mt-4">
                  <input type="hidden" name="intent" value="kiosk-class" />
                  <input type="hidden" name="classId" value={klass.classId} />
                  <input type="hidden" name="deviceId" value={params.deviceId} />
                  <input
                    className="input"
                    name="memberId"
                    placeholder="Type a name to check someone in"
                    autoComplete="off"
                    style={{ fontSize: 16, padding: 12 }}
                  />
                  <button className="btn btn-primary mt-2" type="submit" style={{ width: '100%', padding: 14 }}>
                    Check in
                  </button>
                </form>
              </div>
            ))
          )}
        </section>

        <section>
          <h2 style={{ fontSize: 16, marginBottom: 10 }}>Quick tap</h2>
          <p className="muted tiny">Active members. Tap to check in.</p>
          <div className="grid grid-2">
            {members.map((member) => (
              <form action="/api/actions" method="post" key={member.id}>
                <input type="hidden" name="intent" value="kiosk-class" />
                <input type="hidden" name="classId" value={landing.defaultClassId ?? ''} />
                <input type="hidden" name="deviceId" value={params.deviceId} />
                <input type="hidden" name="memberId" value={member.id} />
                <button
                  className="card card-pad"
                  type="submit"
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 15,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{member.name}</div>
                  <div className="muted tiny">{member.planId}</div>
                </button>
              </form>
            ))}
          </div>
        </section>
      </div>

      <p className="muted tiny mt-4">
        Average fill today {pct(classes.length ? classes.reduce((a, c) => a + c.confirmed, 0) / Math.max(1, classes.reduce((a, c) => a + c.capacity, 0)) : 0)}.
        Next class {time(landing.defaultClassId ? classes.find((c) => c.classId === landing.defaultClassId)?.startTime : undefined)}.
      </p>
    </main>
  );
}
