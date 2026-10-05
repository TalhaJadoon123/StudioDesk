/**
 * Integrity check for node_modules.
 *
 * The interrupted installs on this machine left a few packages extracted but
 * incomplete (their `main` file missing). `require()` then fails with a
 * confusing "Cannot find module" pointing at a file that does not exist.
 *
 * This walks every installed package, resolves its entry point, and reports
 * anything broken.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');

function packageDirs(dir, depth = 0, out = []) {
  if (depth > 3 || !fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === '.bin' || entry.name === '.cache') continue;
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      packageDirs(full, depth + 1, out);
      continue;
    }
    out.push(full);
    // Nested node_modules can hold their own (possibly broken) copies.
    packageDirs(path.join(full, 'node_modules'), depth + 1, out);
  }
  return out;
}

function entryPoints(manifest) {
  const out = [];
  if (typeof manifest.main === 'string') out.push(manifest.main);
  if (manifest.exports) {
    const walkExports = (node) => {
      if (typeof node === 'string') out.push(node);
      else if (node && typeof node === 'object') {
        for (const value of Object.values(node)) {
          if (typeof value === 'string' || typeof value === 'object') walkExports(value);
        }
      }
    };
    walkExports(manifest.exports);
  }
  return out.filter(Boolean).map((entry) => entry.replace(/^\.\//, ''));
}

const broken = [];
let checked = 0;

for (const pkgDir of packageDirs(NODE_MODULES)) {
  const manifestPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(manifestPath)) continue;
  checked += 1;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    broken.push({ pkgDir, reason: 'unreadable package.json' });
    continue;
  }

  const entries = entryPoints(manifest);
  if (!entries.length) continue;

  // A conditional export often points at .d.ts - only check real runtime files.
  const candidates = entries.filter((entry) => !/\.(d\.ts|d\.mts|d\.cts|json)$/.test(entry));
  const hasRuntimeEntry = candidates.some((entry) => {
    const target = path.join(pkgDir, entry);
    return fs.existsSync(target) || fs.existsSync(`${target}.js`) || fs.existsSync(`${target}.cjs`) || fs.existsSync(`${target}.mjs`);
  });

  if (!hasRuntimeEntry) {
    broken.push({ pkgDir, reason: `no entry point on disk (main=${manifest.main ?? 'n/a'})`, entries: candidates.slice(0, 4) });
  }
}

console.log(`Checked ${checked} package(s).`);
if (!broken.length) {
  console.log('All package entry points resolve.');
} else {
  console.log(`\n${broken.length} broken package(s):`);
  for (const item of broken) {
    console.log(`  ${path.relative(ROOT, item.pkgDir)}`);
    console.log(`    ${item.reason}`);
    if (item.entries) console.log(`    looked for: ${item.entries.join(', ')}`);
  }
  process.exitCode = 1;
}