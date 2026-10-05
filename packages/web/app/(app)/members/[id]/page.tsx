import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDesk } from '@/lib/desk';
import { AppShell, PageHeader, Stat, Badge, Empty, FillBar } from '@/lib/components';
import { money, pct, dayTime, day, time, riskTone, ago } from '@/lib/format';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { id: string } }) {
  const desk = getDesk();
  const member = await desk.members.getMember(desk.ctx, params.id);
  return { title: member?.name ?? 'Member' };
}

export default async function MemberDetailPage({ params }: { params: { id: string } }) {
  const desk = getDesk();
  const detail = await desk.members.getMemberDetail(desk.ctx, params.id).catch(() => null);
  if (!detail) notFound();

  const { member, stats } = detail;
  const [plans, prediction] = await Promise.all([
    desk.plans.listPlans(desk.ctx),
    desk.churn.scoreMember(desk.ctx, member.id),
  ]);
  const plan = plans.find((p) => p.id === member.planId);
  const studio = await desk.studio.getStudio(desk.ctx);

  return (
    <AppShell studioName={studio.name} tier={studio.tier}>
      <PageHeader
        title={member.name}
        subtitle={`${member.email ?? 'no email'} - joined ${day(member.joinedAt)}`}
        actions={
          <>
            <Badge
              tone={
                member.status === 'active' ? 'ok' : member.status === 'paused' ? 'warn' : 'neutral'
              }
            >
              {member.status}
            </Badge>
            {member.status === 'active' ? (
              <form action="/api/actions" method="post">
                <input type="hidden" name="intent" value="pause" />
                <input type="hidden" name="memberId" value={member.id} />
                <button className="btn btn-sm" type="submit">
                  Pause
                </button>
              </form>
            ) : null}
            <form action="/api/actions" method="post">
              <input type="hidden" name="intent" value="cancel" />
              <input type="hidden" name="memberId" value={member.id} />
              <button className="btn btn-sm btn-danger" type="submit">
                Cancel membership
              </button>
            </form>
          </>
        }
      />

      <div className="grid grid-4 mb-4">
        <Stat label="Plan" value={plan?.name ?? member.planId} meta={plan ? `${money(plan.priceCents)}/month` : ''} />
        <Stat label="Credits left" value={String(member.packCredits)} meta={`${member.totalBookings} bookings all time`} />
        <Stat
          label="Lifetime revenue"
          value={money(stats.revenueCents)}
          meta={stats.outstandingCents > 0 ? `${money(stats.outstandingCents)} outstanding` : 'nothing outstanding'}
        />
        <Stat
          label="Churn risk"
          value={pct(member.churnRisk)}
          meta={prediction.band.replace('-', ' ')}
        />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h3>Upcoming bookings</h3>
            <span className="tiny muted">{detail.upcoming.length}</span>
          </div>
          {detail.upcoming.length === 0 ? (
            <Empty>Nothing booked. <Link href="/schedule">Schedule</Link></Empty>
          ) : (
            <table className="table">
              <tbody>
                {detail.upcoming.map((row) => (
                  <tr key={row.bookingId}>
                    <td>
                      <div className="stack">
                        <span style={{ fontWeight: 500 }}>{row.className}</span>
                        <span className="tiny muted">{dayTime(row.startTime)}</span>
                      </div>
                    </td>
                    <td className="right">
                      <Badge tone={row.status === 'waitlisted' ? 'warn' : 'ok'}>{row.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card card-pad">
          <div className="row-between mb-4">
            <h3>Attendance</h3>
            <span className={`score-ring ${riskTone(member.churnRisk) === 'danger' ? 'badge danger' : 'badge ok'}`}>
              {pct(member.attendanceRate)}
            </span>
          </div>
          <table className="table">
            <tbody>
              <tr>
                <td>Visits last 30 days</td>
                <td className="num">{member.visitsLast30Days}</td>
              </tr>
              <tr>
                <td>Visits previous 30 days</td>
                <td className="num">{member.visitsPrev30Days}</td>
              </tr>
              <tr>
                <td>Days since last visit</td>
                <td className="num">{member.daysSinceLastVisit ?? 'never'}</td>
              </tr>
              <tr>
                <td>Attendance rate</td>
                <td className="num">{pct(member.attendanceRate)}</td>
              </tr>
              <tr>
                <td>Late cancels</td>
                <td className="num">{member.lateCancels}</td>
              </tr>
              <tr>
                <td>No-shows</td>
                <td className="num">{member.noShows}</td>
              </tr>
              <tr>
                <td>Avg visits / week</td>
                <td className="num">{stats.avgVisitsPerWeek}</td>
              </tr>
              <tr>
                <td>Tenure</td>
                <td className="num">{member.tenureDays} days</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-4">
            <div className="nav-label" style={{ padding: '0 0 6px' }}>
              Last 30 days vs previous
            </div>
            <FillBar fill={member.visitsPrev30Days > 0 ? member.visitsLast30Days / (member.visitsPrev30Days * 2) : 0} />
          </div>
        </section>
      </div>

      <div className="grid grid-3 mt-4">
        <section className="card">
          <div className="card-head">
            <h3>Class packs</h3>
          </div>
          {detail.packs.length === 0 ? (
            <Empty>No packs purchased.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {detail.packs.map((pack) => (
                  <tr key={pack.id}>
                    <td>
                      <div className="stack">
                        <span>{pack.name}</span>
                        {pack.expiresAt ? (
                          <span className="tiny muted">expires {day(pack.expiresAt)}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="num">
                      {pack.creditsRemaining}
                      <div className="tiny muted">left</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Invoices</h3>
          </div>
          {detail.invoices.length === 0 ? (
            <Empty>Nothing billed yet.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {detail.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <div className="stack">
                        <span className="mono tiny">{invoice.number}</span>
                        <span className="tiny muted">{day(invoice.createdAt)}</span>
                      </div>
                    </td>
                    <td className="num">{money(invoice.totalCents)}</td>
                    <td className="right">
                      <Badge tone={invoice.status === 'paid' ? 'ok' : 'warn'}>{invoice.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Fees</h3>
          </div>
          {detail.fees.length === 0 ? (
            <Empty>No fees assessed.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {detail.fees.map((fee) => (
                  <tr key={fee.id}>
                    <td>
                      <div className="stack">
                        <span className="tiny">{fee.kind.replace('-', ' ')}</span>
                        <span className="tiny muted">{day(fee.assessedAt)}</span>
                      </div>
                    </td>
                    <td className="num">{money(fee.amountCents)}</td>
                    <td className="right">
                      <Badge tone={fee.status === 'charged' ? 'danger' : fee.status === 'waived' ? 'ok' : 'warn'}>
                        {fee.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card mt-4">
        <div className="card-head">
          <h3>Retention signals</h3>
          {prediction.ai ? <Badge tone="info">Groq: {prediction.model}</Badge> : <Badge tone="neutral">heuristic</Badge>}
        </div>
        <div className="card-pad">
          <p className="mt-0">{prediction.explanation}</p>
          <p className="muted">{prediction.recommendation}</p>
          {prediction.signals.length > 0 ? (
            <div className="row wrap mt-4">
              {prediction.signals.map((signal) => (
                <Badge
                  key={signal.code}
                  tone={signal.severity === 'critical' ? 'danger' : signal.severity === 'warning' ? 'warn' : 'ok'}
                >
                  {signal.label}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="tiny muted">No negative signals - this member is in good shape.</p>
          )}
        </div>
      </section>

      <section className="card mt-4">
        <div className="card-head">
          <h3>Class history</h3>
          <span className="tiny muted">{detail.history.length} most recent</span>
        </div>
        {detail.history.length === 0 ? (
          <Empty>No past classes.</Empty>
        ) : (
          <table className="table">
            <tbody>
              {detail.history.map((row) => (
                <tr key={row.bookingId}>
                  <td className="mono tiny" style={{ width: 70 }}>
                    {time(row.startTime)}
                  </td>
                  <td>{row.className}</td>
                  <td className="tiny muted">{day(row.startTime)}</td>
                  <td className="right">
                    <Badge
                      tone={
                        row.status === 'attended' ? 'ok' : row.status === 'no-show' ? 'danger' : 'neutral'
                      }
                    >
                      {row.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="tiny muted mt-4">
        Last updated {ago(new Date().toISOString())}.
      </p>
    </AppShell>
  );
}
