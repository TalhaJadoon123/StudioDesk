import { getDesk } from '@/lib/desk';
import { AppShell, PageHeader, Stat, Badge, Empty } from '@/lib/components';
import { money, pct, day } from '@/lib/format';

export const metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const desk = getDesk();
  const { memberships, dunningSummary, recurringRevenue, upcomingRenewals } = await import(
    '@studiodesk/billing'
  );

  const [studio, revenue, plans, mrr, dunning, renewals, pastDue, packs] = await Promise.all([
    desk.studio.getStudio(desk.ctx),
    desk.reports.revenueReport(desk.ctx, { days: 30 }),
    desk.plans.listPlans(desk.ctx),
    recurringRevenue(desk.ctx),
    dunningSummary(desk.ctx),
    upcomingRenewals(desk.ctx, 14),
    memberships.listMemberships(desk.ctx, { status: 'past_due' }),
    desk.ctx.repo.table('packs').list(),
  ]);

  const members = await desk.ctx.repo.table('members').list();
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const activePackCredits = packs
    .filter((p) => p.status === 'active')
    .reduce((acc, p) => acc + p.creditsRemaining, 0);

  return (
    <AppShell studioName={studio.name} tier={studio.tier}>
      <PageHeader
        title="Billing"
        subtitle={`${mrr.activeMemberships} active subscriptions - ${money(mrr.mrrCents)} MRR`}
        actions={
          <form action="/api/actions" method="post">
            <input type="hidden" name="intent" value="run-dunning" />
            <button className="btn btn-sm" type="submit">
              Run dunning now
            </button>
          </form>
        }
      />

      <div className="grid grid-4 mb-4">
        <Stat
          label="Collected (30d)"
          value={money(revenue.netCents)}
          meta={`${revenue.transactions} transactions`}
        />
        <Stat
          label="Memberships"
          value={money(revenue.membershipsCents)}
          meta={`avg ${money(revenue.averageTransactionCents)} per charge`}
        />
        <Stat
          label="Packs & drop-ins"
          value={money(revenue.packsCents + revenue.dropInsCents)}
          meta={`${activePackCredits} credits outstanding to members`}
        />
        <Stat
          label="Fees"
          value={money(revenue.feesCents)}
          meta={revenue.feesCents > 0 ? 'late cancels + no-shows' : 'none charged'}
        />
      </div>

      <div className="grid grid-2 mb-4">
        <section className="card">
          <div className="card-head">
            <h3>Revenue mix (30 days)</h3>
          </div>
          <table className="table">
            <tbody>
              <tr>
                <td>Memberships</td>
                <td className="num">{money(revenue.membershipsCents)}</td>
                <td className="num tiny muted">
                  {pct(revenue.grossCents ? revenue.membershipsCents / revenue.grossCents : 0)}
                </td>
              </tr>
              <tr>
                <td>Class packs</td>
                <td className="num">{money(revenue.packsCents)}</td>
                <td className="num tiny muted">
                  {pct(revenue.grossCents ? revenue.packsCents / revenue.grossCents : 0)}
                </td>
              </tr>
              <tr>
                <td>Drop-ins</td>
                <td className="num">{money(revenue.dropInsCents)}</td>
                <td className="num tiny muted">
                  {pct(revenue.grossCents ? revenue.dropInsCents / revenue.grossCents : 0)}
                </td>
              </tr>
              <tr>
                <td>Fees</td>
                <td className="num">{money(revenue.feesCents)}</td>
                <td className="num tiny muted">
                  {pct(revenue.grossCents ? revenue.feesCents / revenue.grossCents : 0)}
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Net</strong>
                </td>
                <td className="num">
                  <strong>{money(revenue.netCents)}</strong>
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Smart dunning</h3>
            {dunning.pastDue > 0 ? <Badge tone="danger">{dunning.pastDue} past due</Badge> : <Badge tone="ok">all healthy</Badge>}
          </div>
          <div className="card-pad">
            <div className="grid grid-2 mb-4">
              <Stat label="At-risk MRR" value={money(dunning.atRiskRevenueCents)} />
              <Stat label="Recovered (30d)" value={money(dunning.recoveredCents)} />
            </div>
            <p className="tiny muted">
              Retries on days 1, 3 and 5. The membership pauses on day 7 and cancels on day 21 if the
              card still fails.
              {dunning.averageDaysToRecover > 0
                ? ` Average recovery: ${dunning.averageDaysToRecover} days.`
                : ''}
            </p>
            {dunning.nextActions.length > 0 ? (
              <table className="table mt-4">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th className="num">Attempt</th>
                    <th className="num">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {dunning.nextActions.map((action) => (
                    <tr key={action.membershipId}>
                      <td>{memberName.get(action.memberId) ?? action.memberId}</td>
                      <td className="num tiny muted">stage {action.stage}</td>
                      <td className="num tiny">{day(action.dueAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </section>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h3>Plans</h3>
            <span className="tiny muted">{plans.length}</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Plan</th>
                <th className="num">Price</th>
                <th className="num">Credits</th>
                <th className="num">Members</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => {
                const row = mrr.byPlan.find((r) => r.planId === plan.id);
                return (
                  <tr key={plan.id}>
                    <td>
                      <div className="stack">
                        <span style={{ fontWeight: 500 }}>{plan.name}</span>
                        {plan.description ? <span className="tiny muted">{plan.description}</span> : null}
                      </div>
                    </td>
                    <td className="num">{money(plan.priceCents)}</td>
                    <td className="num">{plan.classCredits ?? '∞'}</td>
                    <td className="num">{row?.members ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Upcoming renewals</h3>
            <span className="tiny muted">next 14 days</span>
          </div>
          {renewals.length === 0 ? (
            <Empty>No renewals in the next two weeks.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Plan</th>
                  <th className="num">Amount</th>
                  <th className="num">Days</th>
                </tr>
              </thead>
              <tbody>
                {renewals.map((row) => (
                  <tr key={row.membershipId}>
                    <td>{row.memberName ?? row.memberId}</td>
                    <td className="tiny">{row.planName}</td>
                    <td className="num">{money(row.amountCents)}</td>
                    <td className="num tiny muted">{row.daysUntil}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {pastDue.length > 0 ? (
        <section className="card mt-4">
          <div className="card-head">
            <h3>Past due</h3>
            <Badge tone="danger">{pastDue.length}</Badge>
          </div>
          <table className="table">
            <tbody>
              {pastDue.map((membership) => (
                <tr key={membership.id}>
                  <td>{memberName.get(membership.memberId) ?? membership.memberId}</td>
                  <td className="tiny muted">stage {membership.dunningStage ?? 0}</td>
                  <td className="tiny muted">next attempt {day(membership.nextDunningAttemptAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </AppShell>
  );
}
