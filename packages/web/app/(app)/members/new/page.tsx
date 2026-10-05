import { getDesk } from '@/lib/desk';
import { AppShell, PageHeader } from '@/lib/components';
import { money } from '@/lib/format';

export const metadata = { title: 'New member' };
export const dynamic = 'force-dynamic';

export default async function NewMemberPage() {
  const desk = getDesk();
  const [studio, plans] = await Promise.all([
    desk.studio.getStudio(desk.ctx),
    desk.plans.listPlans(desk.ctx),
  ]);

  return (
    <AppShell studioName={studio.name} tier={studio.tier}>
      <PageHeader title="Add a member" subtitle="Takes about fifteen seconds." />

      <div style={{ maxWidth: 520 }}>
        <form className="card card-pad" action="/api/actions" method="post">
          <input type="hidden" name="intent" value="create-member" />

          <div className="field">
            <label className="label" htmlFor="name">
              Full name
            </label>
            <input className="input" id="name" name="name" required maxLength={120} autoFocus />
          </div>

          <div className="field">
            <label className="label" htmlFor="email">
              Email
            </label>
            <input className="input" id="email" name="email" type="email" />
            <div className="hint">Used for receipts and waitlist notifications.</div>
          </div>

          <div className="field">
            <label className="label" htmlFor="phone">
              Phone
            </label>
            <input className="input" id="phone" name="phone" type="tel" placeholder="+44 7700 900000" />
            <div className="hint">Only needed if you want SMS waitlist alerts.</div>
          </div>

          <div className="field">
            <label className="label" htmlFor="planId">
              Plan
            </label>
            <select className="select" id="planId" name="planId" defaultValue={plans[0]?.id}>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} - {money(plan.priceCents)}/month
                  {plan.classCredits === null ? ' (unlimited)' : ` (${plan.classCredits} credits)`}
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <button className="btn btn-primary" type="submit">
              Create member
            </button>
            <a className="btn" href="/members">
              Cancel
            </a>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
