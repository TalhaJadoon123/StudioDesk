// Release gate: scan every git-tracked file for credential-shaped strings.
// Read-only. Prints "<path>:<line> <pattern-name>" for each hit.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const PATTERNS = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['github-pat', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['stripe-secret', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['polar-token', /\bpolar_oat_[A-Za-z0-9]{20,}\b/],
  ['groq-key', /\bgsk_[A-Za-z0-9]{20,}\b/],
  ['resend-key', /\bre_[A-Za-z0-9]{20,}\b/],
  ['supabase-jwt', /\beyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  // Generic assignment of a secret-ish name to a literal value.
  ['hardcoded-secret-assignment', /(?:secret|password|passwd|api[_-]?key|token)\s*[:=]\s*['"][^'"]{12,}['"]/i],
];

/** Files where a match is expected and therefore not a finding. */
const ALLOWLIST = new Set(['.env.example']);

/**
 * Test fixtures hold fake credentials by design - a webhook signature test
 * needs a secret to sign with. Rather than allowlisting whole files (which
 * would hide a real key pasted into a test), require the literal to be
 * obviously fake: built from a known placeholder and not matching any
 * provider's real key format.
 */
const FIXTURE_LITERALS = new Set([
  'whsec_test_secret',
  'polar_webhook_test',
  'test-checkin-secret',
  'test-api-key-0123456789abcdef',
  'other',
  'dev-secret-change-me',
]);

/** Patterns that describe a real credential and are never acceptable anywhere. */
const CRITICAL = new Set([
  'aws-access-key',
  'private-key-block',
  'github-pat',
  'slack-token',
  'stripe-secret',
  'polar-token',
  'groq-key',
  'resend-key',
  'supabase-jwt',
  'google-api-key',
  'npm-token',
]);

const isTestFile = (file) => /(^|[\\/])test[\\/]/.test(file) || /\.test\.tsx?$/.test(file);

/** Extracts the literal assigned to a `secret`-like identifier. */
function assignedLiteral(line) {
  const m = /(?:secret|password|passwd|api[_-]?key|token)\w*\s*[:=]\s*['"]([^'"]+)['"]/i.exec(line);
  return m ? m[1] : null;
}

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

let findings = 0;
let suppressed = 0;

/** Prints a finding with the credential redacted. */
function report(file, index, line, name, literal) {
  const excerpt = (literal ?? line)
    .replace(/[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 3)}***${m.slice(-2)}`)
    .trim()
    .slice(0, 110);
  console.log(`FINDING ${file}:${index + 1} [${name}] ${excerpt}`);
  findings += 1;
}

for (const file of files) {
  if (ALLOWLIST.has(file)) continue;
  if (!fs.existsSync(file)) continue;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    continue;
  }
  if (stat.size > 2_000_000) {
    console.log(`SKIP (too large) ${file}`);
    continue;
  }
  // Binary check.
  const head = fs.readFileSync(file).subarray(0, 1024);
  if (head.includes(0)) continue;

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const [name, regex] of PATTERNS) {
      if (!regex.test(line)) continue;

      // A real-provider pattern match is always a finding, even in a test.
      if (CRITICAL.has(name)) {
        report(file, index, line, name);
        continue;
      }

      // The generic assignment pattern only fires on `name = 'literal'`.
      const literal = assignedLiteral(line);
      if (!literal) {
        report(file, index, line, name);
        continue;
      }
      if (isTestFile(file) && FIXTURE_LITERALS.has(literal)) {
        suppressed += 1;
        continue;
      }
      report(file, index, line, name, literal);
    }
  });
}

console.log(`\nScanned ${files.length} tracked file(s).`);
console.log(`Findings: ${findings} (suppressed ${suppressed} known test fixture(s)).`);
process.exitCode = findings > 0 ? 1 : 0;
