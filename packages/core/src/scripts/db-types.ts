/**
 * `npm run schema:print`
 *
 * Prints the SQL to paste into the Supabase SQL editor. StudioDesk deliberately
 * uses one JSONB table so the free tier stays small and migrations stay boring.
 */
import { SUPABASE_SCHEMA_SQL } from '../supabase.js';
import { config } from '@studiodesk/shared';

function main(): void {
  const url = config.supabaseUrl();
  console.log('\n  StudioDesk schema');
  console.log('  -----------------');
  console.log(`  project url : ${url ?? '(NEXT_PUBLIC_SUPABASE_URL not set)'}\n`);
  console.log(SUPABASE_SCHEMA_SQL);
  console.log('\n  Paste the SQL above into Supabase -> SQL Editor -> New query -> Run.');
  console.log('  Then set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env\n');
}

main();