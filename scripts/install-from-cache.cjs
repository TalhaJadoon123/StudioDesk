/**
 * Offline installer.
 *
 * `npm install` works but its reify step stalls badly on this machine's
 * network. Resolution is fine though, so this script does the extraction
 * itself: it walks package-lock.json and materialises node_modules straight
 * from npm's content-addressed cache, then generates the `.bin` shims.
 *
 * Usage:  node scripts/install-from-cache.cjs
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const CACACHE = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'node', 'node_modules', 'npm', 'node_modules', 'cacache');
const cacache = require(CACACHE);

const ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_cacache');
const LOCK = path.join(ROOT, 'package-lock.json');

let installed = 0;
let cached = 0;
let missing = 0;
const missingList = [];

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function extractFromCache(entry, dest) {
  const url = entry.resolved;
  if (!url) return false;
  return { url };
}

/** Async: pull one tarball out of cacache into `dest`. */
async function materialise(key, url, dest) {
  const info = await cacache.get.info(CACHE_PATH, `make-fetch-happen:request-cache:${url}`);
  if (!info) return 'not-cached';

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-install-'));
  try {
    const tarball = path.join(tmp, 'pkg.tgz');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tarball);
      const input = cacache.get.stream.byDigest(CACHE_PATH, info.integrity);
      input.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      input.pipe(out);
    });

    const extractDir = path.join(tmp, 'x');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', extractDir], { stdio: 'pipe' });

    const src = path.join(extractDir, 'package');
    if (!fs.existsSync(src)) return 'bad-tarball';

    rimraf(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    return 'ok';
  } finally {
    rimraf(tmp);
  }
}

/** Writes .bin shims for every installed package that declares a bin entry. */
function writeBins(nodeModulesDir, packageDirs) {
  const binDir = path.join(nodeModulesDir, '.bin');
  fs.mkdirSync(binDir, { recursive: true });

  let shimCount = 0;
  for (const pkgDir of packageDirs) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.bin) continue;

    const bins =
      typeof manifest.bin === 'string'
        ? { [manifest.name.split('/').pop()]: manifest.bin }
        : manifest.bin;

    for (const [name, rel] of Object.entries(bins)) {
      if (!rel) continue;
      const target = path.join(pkgDir, rel);
      if (!fs.existsSync(target)) continue;

      // Unix shim
      const shPath = path.join(binDir, name);
      fs.writeFileSync(
        shPath,
        `#!/bin/sh\nexec node "${target.replace(/\\/g, '/')}" "$@"\n`,
      );
      try {
        fs.chmodSync(shPath, 0o755);
      } catch {
        /* windows */
      }

      // Windows shim - npm's own layout, so `npm test` behaves normally.
      fs.writeFileSync(
        path.join(binDir, `${name}.cmd`),
        `@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n"%_prog%" "${target}" %*\r\nENDLOCAL\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b 0\r\n`,
      );
      fs.writeFileSync(
        path.join(binDir, `${name}.ps1`),
        `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& node "${target}" $args\n`,
      );
      shimCount += 1;
    }
  }
  return shimCount;
}

async function main() {
  if (!fs.existsSync(LOCK)) {
    console.error('package-lock.json not found. Run: npm install --package-lock-only --offline');
    process.exitCode = 1;
    return;
  }

  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const entries = Object.entries(lock.packages).filter(([key]) => key.startsWith('node_modules/'));
  console.log(`Installing ${entries.length} packages from the npm cache...\n`);

  const packageDirs = [];
  const links = [];

  for (const [key, entry] of entries) {
    const dest = path.join(ROOT, key);

    if (entry.link) {
      links.push({ dest, target: path.join(ROOT, entry.resolved) });
      continue;
    }
    if (!entry.resolved) continue;

    const result = await materialise(key, entry.resolved, dest);
    if (result === 'ok') {
      installed += 1;
      if (installed % 25 === 0) console.log(`  ...${installed} extracted`);
      packageDirs.push(dest);
    } else if (result === 'not-cached') {
      missing += 1;
      missingList.push(`${entry.name}@${entry.version}`);
      console.log(`  MISSING FROM CACHE: ${entry.name}@${entry.version}`);
    } else {
      console.log(`  FAILED (${result}): ${entry.name}@${entry.version}`);
      missing += 1;
      missingList.push(`${entry.name}@${entry.version}`);
    }
  }

  // Workspace links (junction = no admin rights needed on Windows).
  for (const { dest, target } of links) {
    rimraf(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.symlinkSync(target, dest, 'junction');
    } catch (error) {
      console.log(`  link failed ${dest}: ${error.message}`);
    }
  }

  const shims = writeBins(path.join(ROOT, 'node_modules'), packageDirs);

  console.log(`\n  extracted : ${installed}`);
  console.log(`  links     : ${links.length}`);
  console.log(`  bin shims : ${shims}`);
  console.log(`  missing   : ${missing}`);
  if (missingList.length) console.log(`  -> ${missingList.join(', ')}`);
  console.log('\n  Done.\n');
}

main().catch((error) => {
  console.error('FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});