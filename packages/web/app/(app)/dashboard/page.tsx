import Link from 'next/link';
import { getDesk } from '@/lib/desk';
import { AppShell, PageHeader, Stat, Badge, Empty, FillBar } from '@/lib/components';
import { money, pct, time, ago, countdown, fillTone } from '@/lib/format';

export const metadata = { title: 'Dashboard' };
// Attendance and check-ins change minute to minute.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const desk = getDesk();
  const [snapshot, health] = await Promise.all([
    desk.reports.dashboardSnapshot(desk.ctx),
    desk.reports.studioHealthCheck(desk.ctx),
  ]);

  const newMembersDelta =
    snapshot.newMembersLastMonth > 0
      ? snapshot.newMembersThisMonth - snapshot.newMembersLastMonth
      : undefined;

  return (
    <AppShell studioName={snapshot.studio.name} tier={snapshot.studio.tier}>
      <PageHeader
        title="Today"
        subtitle={`${snapshot.studio.name} - ${snapshot.activeMembers} active members`}
        actions={
          <>
            <Link href="/schedule" className="btn btn-sm">
              Schedule
            </Link>
            <Link href="/members/new" className="btn btn-sm btn-primary">
              Add member
            </Link>
          </>
        }
      />

      <div className="grid grid-4 mb-4">
        <Stat
          label="Revenue this month"
          value={money(snapshot.revenueMonthCents)}
          meta={`${money(snapshot.revenueTodayCents)} today`}
        />
        <Stat
          label="Recurring revenue"
          value={money(snapshot.mrrCents)}
          meta={`${snapshot.activeMembers} paid plans`}
        />
        <Stat
          label="New members"
          value={String(snapshot.newMembersThisMonth)}
          delta={
            newMembersDelta !== undefined
              ? {
                  value: String(Math.abs(newMembersDelta)),
                  direction: newMembersDelta >= 0 ? 'up' : 'down',
                }
              : undefined
          }
          meta={newMembersDelta === undefined ? 'vs last month' : 'vs last month'}
        />
        <Stat
          label="At risk"
          value={String(snapshot.atRiskCount)}
          meta="members to contact"
        />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Today's bookings" value={String(snapshot.todayBookings)} meta={pct(snapshot.fillRate) + ' filled'} />
        <Stat label="Checked in" value={String(snapshot.todayCheckedIn)} meta="of today's bookings" />
        <Stat label="Paused" value={String(snapshot.pausedMembers)} meta="memberships on hold" />
        <Stat label="Cancelled" value={String(snapshot.cancelledMembers)} meta="all time" />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h3>Today's classes</h3>
            <Link href="/schedule" className="btn btn-sm">
              Full schedule
            </Link>
          </div>
          {snapshot.todayClasses.length === 0 ? (
            <Empty>No classes scheduled today.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Class</th>
                  <th className="num">Booked</th>
                  <th style={{ width: 130 }}>Fill</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.todayClasses.map((klass) => {
                  const fill = klass.capacity ? klass.booked / klass.capacity : 0;
                  return (
                    <tr key={klass.id}>
                      <td className="mono">{time(klass.startTime)}</td>
                      <td>
                        <div className="stack">
                          <span style={{ fontWeight: 500 }}>{klass.name}</span>
                          <span className="tiny muted">
                            {klass.waitlisted > 0 ? `${klass.waitlisted} waiting` : countdown(klass.startTime)}
                          </span>
                        </div>
                      </td>
                      <td className="num">
                        {klass.booked}/{klass.capacity}
                        {klass.attended > 0 ? (
                          <div className="tiny muted">{klass.attended} in</div>
                        ) : null}
                      </td>
                      <td>
                        <FillBar fill={fill} />
                        <div className="tiny muted">{pct(fill)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <div className="stack" style={{ gap: 16 }}>
          <section className="card card-pad">
            <div className="row-between">
              <h3>Studio Health Check</h3>
              <span className={`score-ring ${health.grade === 'A' ? 'badge ok' : health.grade === 'D' ? 'badge danger' : 'badge warn'}`}>
                {health.score}
              </span>
            </div>
            <p className="muted tiny mt-2">{health.headline}</p>
            <div className="mt-4">
              {health.checks.map((check) => (
                <div className="row-between" style={{ padding: '5px 0' }} key={check.label}>
                  <div className="row">
                    <Badge
                      tone={
                        check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : 'danger'
                      }
                    >
                      {check.status === 'pass' ? 'OK' : check.status === 'warn' ? 'Watch' : 'Fix'}
                    </Badge>
                    <span className="tiny">{check.label}</span>
                  </div>
                  <span className="tiny muted">{check.detail}</span>
                </div>
              ))}
            </div>
            {health.recommendations.length > 0 ? (
              <div className="mt-4" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div className="nav-label" style={{ padding: '0 0 6px' }}>
                  Do these first
                </div>
                {health.recommendations.map((rec) => (
                  <p className="tiny" key={rec} style={{ marginBottom: 6 }}>
                    {rec}
                  </p>
                ))}
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Busiest upcoming</h3>
            </div>
            {snapshot.topClasses.length === 0 ? (
              <Empty>Nothing scheduled yet.</Empty>
            ) : (
              <table className="table">
                <tbody>
                  {snapshot.topClasses.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td className="num tiny muted">{row.bookings} booked</td>
                      <td style={{ width: 110 }}>
                        <FillBar fill={row.fillRate} />
                      </td>
                      <td className="num tiny muted">{pct(row.fillRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>

      <section className="card mt-4">
        <div className="card-head">
          <h3>Recent activity</h3>
        </div>
        {snapshot.recentActivity.length === 0 ? (
          <Empty>Nothing yet today.</Empty>
        ) : (
          <table className="table">
            <tbody>
              {snapshot.recentActivity.map((item, index) => (
                <tr key={`${item.at}-${index}`}>
                  <td className="tiny muted" style={{ width: 90 }}>
                    {ago(item.at)}
                  </td>
                  <td>
                    <Badge tone={item.kind === 'attendance' ? 'ok' : 'info'}>{item.kind}</Badge>
                  </td>
                  <td>{item.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="tiny muted mt-4">
        Fill tone: <span className={fillTone(1) === 'full' ? 'badge danger' : 'badge ok'}>colour</span>{' '}
        indicates classes at or above capacity.
      </p>
    </AppShell>
  );
}
