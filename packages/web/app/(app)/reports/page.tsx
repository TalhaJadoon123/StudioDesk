import Link from 'next/link';
import { getDesk } from '@/lib/desk';
import { AppShell, PageHeader, Stat, Badge, Empty, FillBar } from '@/lib/components';
import { money, pct, day } from '@/lib/format';

export const metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: { days?: string; tab?: string };
}) {
  const desk = getDesk();
  const days = Math.min(365, Math.max(7, Number(searchParams.days ?? 30) || 30));
  const tab = searchParams.tab === 'churn' ? 'churn' : 'attendance';

  const studio = await desk.studio.getStudio(desk.ctx);
  const [revenue, attendance] = await Promise.all([
    desk.reports.revenueReport(desk.ctx, { days }),
    desk.reports.attendanceReport(desk.ctx, { days }),
  ]);

  // Churn (Groq) is only on the Business plan; skip the call otherwise.
  const churn = await desk.churn.churnReport(desk.ctx, {}, { enrich: studio.tier === 'business' });

  const peakDay = revenue.byDay.reduce(
    (best, day) => (day.netCents > (best?.netCents ?? 0) ? day : best),
    undefined as (typeof revenue.byDay)[number] | undefined,
  );

  return (
    <AppShell studioName={studio.name} tier={studio.tier}>
      <PageHeader
        title="Reports"
        subtitle={`Last ${days} days - ${revenue.transactions} transactions`}
        actions={
          <div className="row" style={{ gap: 4 }}>
            {[7, 30, 90].map((option) => (
              <Link
                className={`btn btn-sm${days === option ? ' btn-primary' : ''}`}
                href={`/reports?days=${option}&tab=${tab}`}
                key={option}
              >
                {option}d
              </Link>
            ))}
          </div>
        }
      />

      <div className="grid grid-4 mb-4">
        <Stat label="Gross revenue" value={money(revenue.grossCents)} meta={`${money(revenue.refundsCents)} refunded`} />
        <Stat label="Net revenue" value={money(revenue.netCents)} meta={peakDay ? `peak ${day(peakDay.date)}` : ''} />
        <Stat
          label="Attendance rate"
          value={pct(attendance.attendanceRate)}
          meta={`${attendance.noShows} no-shows`}
        />
        <Stat label="Churn rate" value={pct(churn.churnRate)} meta={`${churn.churnedLast30Days} left in 30 days`} />
      </div>

      <div className="row mb-4" style={{ gap: 4 }}>
        <Link className={`btn btn-sm${tab === 'attendance' ? ' btn-primary' : ''}`} href={`/reports?days=${days}&tab=attendance`}>
          Attendance
        </Link>
        <Link className={`btn btn-sm${tab === 'revenue' ? ' btn-primary' : ''}`} href={`/reports?days=${days}&tab=revenue`}>
          Revenue
        </Link>
        <Link className={`btn btn-sm${tab === 'churn' ? ' btn-primary' : ''}`} href={`/reports?days=${days}&tab=churn`}>
          Churn
        </Link>
      </div>

      {tab === 'revenue' ? (
        <RevenueTab revenue={revenue} />
      ) : tab === 'churn' ? (
        <ChurnTab churn={churn} tier={studio.tier} />
      ) : (
        <AttendanceTab attendance={attendance} />
      )}
    </AppShell>
  );
}

function AttendanceTab({ attendance }: { attendance: Awaited<ReturnType<Awaited<ReturnType<typeof getDesk>>['reports']['attendanceReport']>> }) {
  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-head">
          <h3>By class</h3>
          <span className="tiny muted">{attendance.byClass.length} classes</span>
        </div>
        {attendance.byClass.length === 0 ? (
          <Empty>No classes in this window.</Empty>
        ) : (
          <div style={{ overflowX: 'auto', maxHeight: 520 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th className="num">Booked</th>
                  <th className="num">Attended</th>
                  <th className="num">No-show</th>
                  <th className="num">Fill</th>
                </tr>
              </thead>
              <tbody>
                {attendance.byClass.map((row) => (
                  <tr key={row.classId}>
                    <td>
                      <div className="stack">
                        <span>{row.className}</span>
                        <span className="tiny muted">{day(row.startTime)}</span>
                      </div>
                    </td>
                    <td className="num">
                      {row.booked}/{row.capacity}
                    </td>
                    <td className="num">{row.attended}</td>
                    <td className="num">
                      {row.noShows > 0 ? <span style={{ color: 'var(--danger)' }}>{row.noShows}</span> : '-'}
                    </td>
                    <td className="num">{pct(row.fillRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>By instructor</h3>
        </div>
        {attendance.byInstructor.length === 0 ? (
          <Empty>No instructor activity.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Instructor</th>
                <th className="num">Classes</th>
                <th className="num">Attended</th>
                <th className="num">Rate</th>
              </tr>
            </thead>
            <tbody>
              {attendance.byInstructor.map((row) => (
                <tr key={row.instructorId}>
                  <td>{row.name}</td>
                  <td className="num">{row.classes}</td>
                  <td className="num">{row.attended}</td>
                  <td className="num">
                    <FillBar fill={row.attendanceRate} />
                    <span className="tiny muted">{pct(row.attendanceRate)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function RevenueTab({ revenue }: { revenue: Awaited<ReturnType<Awaited<ReturnType<typeof getDesk>>['reports']['revenueReport']>> }) {
  const max = Math.max(1, ...revenue.byDay.map((d) => d.netCents));
  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-head">
          <h3>Daily net revenue</h3>
        </div>
        <div className="card-pad">
          <div className="row" style={{ alignItems: 'flex-end', gap: 2, height: 160 }}>
            {revenue.byDay.map((point) => (
              <div
                key={point.date}
                title={`${day(point.date)}: ${money(point.netCents)}`}
                style={{
                  flex: 1,
                  height: `${Math.max(2, (point.netCents / max) * 100)}%`,
                  background: point.netCents > 0 ? 'var(--accent)' : 'var(--surface-2)',
                  borderRadius: 2,
                  minWidth: 2,
                }}
              />
            ))}
          </div>
          <div className="row-between tiny muted mt-2">
            <span>{day(revenue.from)}</span>
            <span>{day(revenue.to)}</span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Top classes by revenue</h3>
        </div>
        {revenue.byClass.length === 0 ? (
          <Empty>No revenue attributed to classes yet.</Empty>
        ) : (
          <table className="table">
            <tbody>
              {revenue.byClass.slice(0, 20).map((row) => (
                <tr key={row.classId}>
                  <td>{row.name}</td>
                  <td className="num tiny muted">{row.bookings} attended</td>
                  <td className="num">{money(row.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function ChurnTab({
  churn,
  tier,
}: {
  churn: Awaited<ReturnType<Awaited<ReturnType<typeof getDesk>>['churn']['churnReport']>>;
  tier: string;
}) {
  return (
    <>
      <section className="card mb-4">
        <div className="card-head">
          <h3>Studio-wide insights</h3>
          {tier === 'business' ? <Badge tone="info">Groq enriched</Badge> : <Badge tone="neutral">Business feature</Badge>}
        </div>
        <div className="card-pad">
          {churn.insights.map((insight) => (
            <p key={insight} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
              <span style={{ color: 'var(--accent)' }}>›</span>
              <span>{insight}</span>
            </p>
          ))}
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <h3>Risk by plan</h3>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Plan</th>
              <th className="num">Members</th>
              <th className="num">At risk</th>
              <th className="num">MRR</th>
            </tr>
          </thead>
          <tbody>
            {churn.byPlan.map((row) => (
              <tr key={row.planId}>
                <td>{row.name}</td>
                <td className="num">{row.members}</td>
                <td className="num">
                  {row.atRisk > 0 ? <span style={{ color: 'var(--warn)' }}>{row.atRisk}</span> : '-'}
                </td>
                <td className="num">{money(row.mrrCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Members to contact</h3>
          <Badge tone={churn.atRisk.length > 0 ? 'warn' : 'ok'}>{churn.atRisk.length}</Badge>
        </div>
        {churn.atRisk.length === 0 ? (
          <Empty>Nobody is flagged. Nice.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th className="num">Risk</th>
                <th>Last visit</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {churn.atRisk.map((member) => (
                <tr key={member.id}>
                  <td>
                    <Link href={`/members/${member.id}`} style={{ fontWeight: 500 }}>
                      {member.name}
                    </Link>
                  </td>
                  <td className="num">
                    <Badge tone={member.churnRisk >= 0.75 ? 'danger' : 'warn'}>
                      {pct(member.churnRisk)}
                    </Badge>
                  </td>
                  <td className="tiny muted">
                    {member.daysSinceLastVisit === null
                      ? 'never'
                      : `${member.daysSinceLastVisit} days ago`}
                  </td>
                  <td className="tiny muted">
                    {member.packCredits === 0 ? 'Offer a class pack' : 'Send a personal check-in'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
