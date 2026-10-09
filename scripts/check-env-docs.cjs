/**
 * Env reference, generated from the source of truth (`config` in
 * @studiodesk/shared) and cross-checked against .env.example.
 *
 * Run as part of the release gate: a var the code reads but the example does
 * not document is a deploy-time surprise.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sharedConfig = fs.readFileSync(
  path.join(root, 'packages', 'shared', 'src', 'config.ts'),
  'utf8',
);
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

// `getString('FOO')` / `getNumber('FOO'` / `getBool('FOO'`
const used = new Set();
for (const m of sharedConfig.matchAll(/get(?:String|Number|Bool)\(\s*'([A-Z0-9_]+)'/g)) {
  used.add(m[1]);
}

/**
 * Vars consumed by infrastructure (wrangler, compose, CI) rather than by
 * application code. Documented for operators, read by tooling, so they are
 * expected to appear in .env.example without a code reference.
 */
const INFRA_VARS = new Set([
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ZONE_ID',
  'EUORG_DOMAIN_API_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'POLAR_PRODUCT_STARTER',
  'POLAR_PRODUCT_BUSINESS',
  'UPTIMEFLARE_API_KEY',
  // Read by the Expo app at runtime, not by Node-side code in this repo.
  'EXPO_PUBLIC_GOOGLE_MAPS_API_KEY',
]);

// process.env.X read directly outside shared/config
const extra = new Set();
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name)) {
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) extra.add(m[1]);
      // process.env['X'] and process.env.X ?? fallback
      for (const m of src.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) extra.add(m[1]);
    }
  }
};
walk(path.join(root, 'packages'));

const documented = new Set(
  [...example.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]),
);

const all = new Set([...used, ...extra]);
const undocumented = [...all].filter((v) => !documented.has(v)).sort();
const unused = [...documented].filter((v) => !all.has(v)).sort();

console.log(`Env vars referenced in code : ${all.size}`);
console.log(`Env vars in .env.example   : ${documented.size}`);
console.log(`\nUndocumented (code reads, example omits):`);
if (undocumented.length === 0) console.log('  none');
for (const v of undocumented) console.log(`  ${v}`);

console.log(`\nDocumented but not referenced by application code:`);
if (unused.length === 0) console.log('  none');
for (const v of unused) {
  const kind = INFRA_VARS.has(v) ? 'infra' : 'UNEXPECTED';
  console.log(`  ${v} (${kind})`);
}

const unexpectedUnused = unused.filter((v) => !INFRA_VARS.has(v));
if (unexpectedUnused.length > 0) {
  console.log(
    `\n  ^ ${unexpectedUnused.length} var(s) documented but never read - remove them or wire them up.`,
  );
}

// A required var in production that is not documented is a blocker.
const blockers = undocumented.filter(
  (v) => /KEY|SECRET|TOKEN|ORIGIN/.test(v) && !v.startsWith('EXPO_'),
);

console.log(`\nBlockers: ${blockers.length}`);
process.exitCode = blockers.length > 0 ? 1 : 0;
