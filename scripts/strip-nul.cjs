/**
 * Strips stray NUL bytes from source files.
 *
 * Some bulk-edit operations on this machine occasionally leave NUL bytes in the
 * output. NUL is never valid in TypeScript/JavaScript source, so removing them
 * is always safe.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['packages', 'scripts'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|cjs|mjs|json|md|sql|yml|yaml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let cleaned = 0;
for (const dir of TARGET_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    const buf = fs.readFileSync(file);
    if (!buf.includes(0)) continue;
    const text = buf.toString('utf8');
    const stripped = text.replace(/\0/g, '');
    fs.writeFileSync(file, stripped, 'utf8');
    cleaned += 1;
    console.log(`  cleaned ${path.relative(ROOT, file)} (${buf.length - stripped.length} NUL bytes removed)`);
  }
}

console.log(cleaned === 0 ? 'No NUL bytes found - nothing to do.' : `\nCleaned ${cleaned} file(s).`);