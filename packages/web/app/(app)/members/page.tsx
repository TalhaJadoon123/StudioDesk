import Link from 'next/link';
import { getDesk } from '@/lib/desk';
import { AppShell, PageHeader, Badge, Empty } from '@/lib/components';
import { money, pct, riskTone } from '@/lib/format';

export const metadata = { title: 'Members' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function MembersPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; page?: string };
}) {
  const desk = getDesk();
  await desk.members.reconcilePauses(desk.ctx);

  const status = (['active', 'paused', 'cancelled'].includes(searchParams.status ?? '')
    ? searchParams.status
    : undefined) as 'active' | 'paused' | 'cancelled' | undefined;
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);

  const result = await desk.members.listMembersPaginated(desk.ctx, {
    search: searchParams.q,
    status,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    sort: 'name',
  });

  // Usage rollup powers the risk column; only for the visible page.
  const withUsage = await Promise.all(result.items.map((m) => desk.members.memberUsage(desk.ctx, m.id)));
  const counts = await desk.members.countByStatus(desk.ctx);
  const studio = await desk.studio.getStudio(desk.ctx);
  const plans = await desk.plans.listPlans(desk.ctx);
  const planName = new Map(plans.map((p) => [p.id, p]));

  const query = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { q: searchParams.q, status: searchParams.status, ...patch };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    return `/members?${next.toString()}`;
  };

  return (
    <AppShell studioName={studio.name} tier={studio.tier}>
      <PageHeader
        title="Members"
        subtitle={`${result.total} member${result.total === 1 ? '' : 's'} - ${counts.active} active, ${counts.paused} paused, ${counts.cancelled} cancelled`}
        actions={
          <Link href="/members/new" className="btn btn-sm btn-primary">
            Add member
          </Link>
        }
      />

      <form className="row wrap mb-4" method="get" action="/members">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          type="search"
          name="q"
          defaultValue={searchParams.q ?? ''}
          placeholder="Search name, email or tag"
          aria-label="Search members"
        />
        <select className="select" style={{ maxWidth: 160 }} name="status" defaultValue={status ?? ''}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button className="btn btn-sm" type="submit">
          Apply
        </button>
        {searchParams.q || status ? (
          <Link className="btn btn-sm" href="/members">
            Clear
          </Link>
        ) : null}
      </form>

      <section className="card">
        {result.items.length === 0 ? (
          <Empty>
            No members match. <Link href="/members/new">Add the first one.</Link>
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Plan</th>
                <th>Status</th>
                <th className="num">Visits (30d)</th>
                <th className="num">Credits</th>
                <th className="num">Balance</th>
                <th className="num">Churn risk</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {withUsage.map((member) => {
                const plan = planName.get(member.planId);
                return (
                  <tr key={member.id}>
                    <td>
                      <div className="row">
                        <span className="avatar">{initialsOf(member.name)}</span>
                        <div className="stack">
                          <Link href={`/members/${member.id}`} style={{ fontWeight: 500 }}>
                            {member.name}
                          </Link>
                          <span className="tiny muted">{member.email ?? 'no email on file'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="tiny">
                      {plan?.name ?? member.planId}
                      {plan ? (
                        <div className="muted">{money(plan.priceCents)}/mo</div>
                      ) : null}
                    </td>
                    <td>
                      <Badge
                        tone={
                          member.status === 'active'
                            ? 'ok'
                            : member.status === 'paused'
                              ? 'warn'
                              : 'neutral'
                        }
                      >
                        {member.status}
                      </Badge>
                    </td>
                    <td className="num">
                      {member.visitsLast30Days}
                      {member.visitsPrev30Days > 0 ? (
                        <div className="tiny muted">was {member.visitsPrev30Days}</div>
                      ) : null}
                    </td>
                    <td className="num">
                      {member.packCredits}
                      {member.packCredits === 0 ? <div className="tiny" style={{ color: 'var(--warn)' }}>none</div> : null}
                    </td>
                    <td className="num">
                      {member.outstandingCents > 0 ? (
                        <span style={{ color: 'var(--danger)' }}>{money(member.outstandingCents)}</span>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td className="num">
                      <Badge tone={riskTone(member.churnRisk)}>{pct(member.churnRisk)}</Badge>
                    </td>
                    <td className="right">
                      <Link href={`/members/${member.id}`} className="btn btn-sm">
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {result.total > PAGE_SIZE ? (
        <div className="row-between mt-4">
          <span className="tiny muted">
            Page {result.page} of {Math.ceil(result.total / PAGE_SIZE)}
          </span>
          <div className="row">
            {result.hasMore ? (
              <Link
                className="btn btn-sm"
                href={query({ page: String(page + 1) })}
              >
                Next
              </Link>
            ) : null}
            {page > 1 ? (
              <Link className="btn btn-sm" href={query({ page: String(page - 1) })}>
                Previous
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}
