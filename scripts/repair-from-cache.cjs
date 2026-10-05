// One-off repair helper: pulls a tarball out of the npm cache and extracts it
// over an incomplete node_modules directory.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const npmRoot = 'C:\\Users\\3tee system\\AppData\\Local\\hermes\\node\\node_modules\\npm\\node_modules\\cacache';
const cacache = require(npmRoot);

const cachePath = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_cacache');

async function main() {
  const [pkg, version, dest] = process.argv.slice(2);
  const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
  const key = `make-fetch-happen:request-cache:${url}`;

  const info = await cacache.get.info(cachePath, key);
  if (!info) {
    console.error(`NOT CACHED: ${url}`);
    process.exitCode = 2;
    return;
  }
  console.log(`cache entry found, integrity=${info.integrity}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npmfix-'));
  const tarball = path.join(tmp, 'pkg.tgz');

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tarball);
    const input = cacache.get.stream.byDigest(cachePath, info.integrity);
    input.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    input.pipe(out);
  });

  console.log(`extracted tarball: ${fs.statSync(tarball).size} bytes`);
  const extractDir = path.join(tmp, 'x');
  fs.mkdirSync(extractDir);
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir], { stdio: 'inherit' });

  const src = path.join(extractDir, 'package');
  if (!fs.existsSync(src)) {
    console.error('tarball did not contain package/');
    process.exitCode = 3;
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log(`OK: ${pkg}@${version} -> ${dest}`);
  console.log(`files: ${fs.readdirSync(dest).join(', ')}`);
}

main().catch((error) => {
  console.error('FAILED:', error && error.message ? error.message : error);
  process.exitCode = 1;
});