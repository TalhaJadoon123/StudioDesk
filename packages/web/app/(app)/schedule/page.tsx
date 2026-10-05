import Link from 'next/link';
import { getDesk } from '@/lib/desk';
import { AppShell, PageHeader, Badge, Empty } from '@/lib/components';
import { pct, time, day } from '@/lib/format';

export const metadata = { title: 'Schedule' };
export const dynamic = 'force-dynamic';

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: { view?: string; anchor?: string };
}) {
  const desk = getDesk();
  const view = searchParams.view === 'month' ? 'month' : 'week';
  const anchor = searchParams.anchor ?? desk.ctx.now().toISOString();

  const calendar =
    view === 'month'
      ? await (await import('@studiodesk/booking')).buildMonthGrid(desk.ctx, anchor)
      : await (await import('@studiodesk/booking')).buildWeekGrid(desk.ctx, anchor);

  const studio = await desk.studio.getStudio(desk.ctx);
  const anchorDate = new Date(anchor);
  const shift = (days: number) =>
    new Date(anchorDate.getTime() + days * 86_400_000).toISOString();

  const instructors = await desk.classes.listInstructors(desk.ctx);

  return (
    <AppShell studioName={studio.name} tier={studio.tier}>
      <PageHeader
        title="Schedule"
        subtitle={`${calendar.summary.totalClasses} classes - ${pct(
          calendar.summary.averageFillRate,
        )} average fill - ${calendar.summary.totalWaitlisted} waiting`}
        actions={
          <>
            <div className="row" style={{ gap: 4 }}>
              <Link
                className={`btn btn-sm${view === 'week' ? ' btn-primary' : ''}`}
                href={`/schedule?view=week&anchor=${encodeURIComponent(shift(view === 'week' ? -7 : -30))}`}
              >
                ←
              </Link>
              <Link className="btn btn-sm" href="/schedule">
                Today
              </Link>
              <Link
                className={`btn btn-sm${view === 'week' ? ' btn-primary' : ''}`}
                href={`/schedule?view=week&anchor=${encodeURIComponent(shift(view === 'week' ? 7 : 30))}`}
              >
                →
              </Link>
            </div>
            <Link
              className={`btn btn-sm${view === 'month' ? ' btn-primary' : ''}`}
              href={`/schedule?view=month&anchor=${encodeURIComponent(anchor)}`}
            >
              Month
            </Link>
            <Link className="btn btn-sm btn-primary" href="/schedule/new">
              Add class
            </Link>
          </>
        }
      />

      <div className="cal-week mb-4">
        {calendar.days.map((dayRow) => (
          <div className={`cal-day${dayRow.isToday ? ' today' : ''}`} key={dayRow.date}>
            <div className="cal-day-head">
              <span>{dayRow.weekdayName.slice(0, 3)}</span>
              <span>{dayRow.date.slice(8)}</span>
            </div>
            {dayRow.entries.length === 0 ? null : (
              <>
                {dayRow.entries.map((entry) => (
                  <div
                    className={`cal-class${entry.isFull ? ' full' : ''}`}
                    key={entry.id}
                    title={`${entry.name} - ${entry.booked}/${entry.capacity} booked`}
                  >
                    <span className="cal-class-time">{entry.timeLabel}</span>
                    {entry.name}
                    <div className="tiny">
                      {entry.booked}/{entry.capacity}
                      {entry.waitlisted > 0 ? ` (+${entry.waitlisted})` : ''}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h3>{view === 'month' ? 'Month' : 'Week'} detail</h3>
            <span className="tiny muted">{day(calendar.from)} - {day(calendar.to)}</span>
          </div>
          {calendar.classes.length === 0 ? (
            <Empty>No classes in this range.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Class</th>
                  <th>Instructor</th>
                  <th className="num">Booked</th>
                </tr>
              </thead>
              <tbody>
                {calendar.classes.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="stack">
                        <span className="mono">{time(entry.startTime)}</span>
                        <span className="tiny muted">{day(entry.startTime)}</span>
                      </div>
                    </td>
                    <td>
                      <div className="stack">
                        <span style={{ fontWeight: 500 }}>{entry.name}</span>
                        {entry.room ? <span className="tiny muted">{entry.room}</span> : null}
                      </div>
                    </td>
                    <td className="tiny">{entry.instructorName ?? '-'}</td>
                    <td className="num">
                      {entry.booked}/{entry.capacity}
                      {entry.isFull ? (
                        <Badge tone="warn">
                          {' '}
                          full
                        </Badge>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Instructors</h3>
            <Link href="/schedule/instructors" className="btn btn-sm">
              Manage
            </Link>
          </div>
          {instructors.length === 0 ? (
            <Empty>No instructors yet.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {instructors.map((instructor) => (
                  <tr key={instructor.id}>
                    <td>
                      <div className="row">
                        <span
                          className="avatar"
                          style={{
                            background: `${instructor.color ?? '#6366f1'}22`,
                            color: instructor.color ?? 'var(--accent)',
                          }}
                        >
                          {instructor.name
                            .split(' ')
                            .slice(0, 2)
                            .map((part) => part[0])
                            .join('')}
                        </span>
                        <div className="stack">
                          <span style={{ fontWeight: 500 }}>{instructor.name}</span>
                          <span className="tiny muted">
                            {instructor.specialties?.join(', ') || 'No specialties listed'}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="right">
                      {instructor.active ? (
                        <Badge tone="ok">active</Badge>
                      ) : (
                        <Badge tone="neutral">inactive</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </AppShell>
  );
}
