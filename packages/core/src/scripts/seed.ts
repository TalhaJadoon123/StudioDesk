/**
 * `npm run seed` / `npm run seed:demo`
 *
 * Creates the demo yoga studio (100 members) in whichever repository the
 * environment points at, then prints a summary. With no Supabase credentials it
 * seeds in memory and dumps a JSON snapshot so nothing is lost.
 */
import { writeFile } from 'node:fs/promises';
import { createStudioDesk } from '../index.js';
import { seedDemoStudio } from '../seed.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDemo = args.includes('--demo') || args.length === 0;
  const membersArg = args.find((a) => a.startsWith('--members='));
  const outArg = args.find((a) => a.startsWith('--out='));

  const desk = await createStudioDesk();
  const driver = desk.ctx.repo.kind;

  console.log(`\n  StudioDesk seed`);
  console.log(`  ----------------`);
  console.log(`  driver     : ${driver}`);
  console.log(`  studio id  : ${desk.ctx.studioId ?? 'std_demo (default)'}`);
  console.log(`  anchored at: ${desk.ctx.now().toISOString()}\n`);

  if (!isDemo) {
    console.log('  Nothing to do - pass --demo or run `npm run seed:demo`.');
    await desk.dispose();
    return;
  }

  const summary = await seedDemoStudio(desk.ctx, {
    members: membersArg ? Number(membersArg.split('=')[1]) : 100,
  });

  console.log('  Seeded:');
  console.log(`    instructors : ${summary.instructors}`);
  console.log(`    plans       : ${summary.plans}`);
  console.log(`    members     : ${summary.members}`);
  console.log(`    classes     : ${summary.classes}`);
  console.log(`    bookings    : ${summary.bookings}`);
  console.log(`    attendance  : ${summary.attendance}`);
  console.log(`    invoices    : ${summary.invoices}`);
  console.log(`    packs       : ${summary.packs}`);
  console.log(`    drop-ins    : ${summary.dropIns}`);
  console.log(`    fees        : ${summary.fees}`);
  console.log(`    memberships : ${summary.memberships}`);

  const dashboard = await desk.reports.dashboardSnapshot(desk.ctx);
  const health = await desk.reports.studioHealthCheck(desk.ctx);

  console.log('\n  Dashboard check:');
  console.log(`    active members : ${dashboard.activeMembers}`);
  console.log(`    MRR            : $${(dashboard.mrrCents / 100).toFixed(2)}`);
  console.log(`    classes today  : ${dashboard.todayClasses.length}`);
  console.log(`    at-risk        : ${dashboard.atRiskCount}`);
  console.log(`    health score   : ${health.score}/100 (${health.grade})`);

  if (driver === 'memory') {
    const dump = (desk.ctx.repo as { dump?: () => Record<string, unknown[]> }).dump?.();
    if (dump) {
      const target = outArg ? outArg.split('=')[1]! : 'seed.json';
      await writeFile(target, JSON.stringify(dump, null, 2));
      console.log(`\n  In-memory seed written to ${target}`);
      console.log('  Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to persist instead.');
    }
  }

  console.log('\n  Done.\n');
  await desk.dispose();
}

main().catch((error) => {
  console.error('\n  Seed failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});