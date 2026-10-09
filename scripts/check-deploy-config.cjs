// Release gate: lint the Dockerfile and compose file without a Docker daemon.
// Static checks only - this cannot prove the image builds.
const fs = require('node:fs');

const findings = [];
const notes = [];

const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
const compose = fs.readFileSync('docker-compose.yml', 'utf8');

// ---- Dockerfile ----------------------------------------------------------
const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)].map(
  (m) => ({ from: m[1], as: m[2] }),
);

if (!/^FROM\s+\S+\s+AS\s+base/im.test(dockerfile)) {
  findings.push('Dockerfile has no named base stage for the hardening layers to inherit');
}

/**
 * Returns the body of one named stage, from its `FROM ... AS <name>` line up
 * to the next `FROM` - so instructions belonging to later stages are not
 * mistaken for this one's.
 */
function stageBody(source, name) {
  // Must match the stage's OWN `FROM` line, not a longer name that merely
  // starts with the same characters (api vs api-build).
  const pattern = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, 'im');
  const match = pattern.exec(source);
  if (!match) return null;
  const after = match.index + match[0].length;
  const rest = source.slice(after);
  const nextFrom = /^FROM\s+/im.exec(rest);
  return nextFrom ? rest.slice(0, nextFrom.index) : rest;
}

const apiBody = stageBody(dockerfile, 'api');
if (!apiBody) {
  findings.push('No `api` target - docker-compose builds `target: api`');
} else {
  if (!/^USER\s+node\s*$/im.test(apiBody)) findings.push('api stage does not drop to USER node');
  if (!/^HEALTHCHECK\s/im.test(apiBody)) findings.push('api stage has no HEALTHCHECK');
  if (!/\/health/.test(apiBody)) findings.push('api HEALTHCHECK does not probe /health');
}

const webBody = stageBody(dockerfile, 'web');
if (webBody) {
  if (!/^USER\s+node\s*$/im.test(webBody)) findings.push('web stage does not drop to USER node');
  if (!/^HEALTHCHECK\s/im.test(webBody)) findings.push('web stage has no HEALTHCHECK');
}

// The typecheck must run in a build stage, not the slim runtime stage.
const buildBody = stageBody(dockerfile, 'api-build') ?? '';
if (!/tsc\s+-p\s+tsconfig\.json\s+--noEmit/.test(buildBody)) {
  findings.push('Dockerfile does not typecheck during build');
}

// Rootless runtime: no stage should install packages or declare root defaults.
for (const stage of ['api', 'web']) {
  const body = stageBody(dockerfile, stage) ?? '';
  if (/^\s*USER\s+root/im.test(body)) findings.push(`${stage} stage switches back to USER root`);
}

// Secret handling
if (/ENV\s+API_KEY=\S/i.test(dockerfile) || /ARG\s+API_KEY/i.test(dockerfile)) {
  findings.push('Dockerfile bakes API_KEY into a layer');
}
if (/npm\s+install\s+(?!.*--ignore-scripts)/.test(stageBody(dockerfile, 'api') ?? '')) {
  notes.push('api stage runs npm install (not npm ci); a lockfile mismatch will not fail loudly');
}

if (!/^#\s+syntax=/m.test(dockerfile)) {
  notes.push('No BuildKit syntax directive; `docker build` must use the modern builder');
}

// Secret handling
if (/ENV\s+API_KEY=\S/i.test(dockerfile) || /ARG\s+API_KEY/i.test(dockerfile)) {
  findings.push('Dockerfile bakes API_KEY into a layer');
}

// ---- compose -------------------------------------------------------------
for (const key of ['api', 'web']) {
  const block = new RegExp(`\\n  ${key}:[\\s\\S]*?(?=\\n  [a-z]|$)`).exec(compose);
  if (!block) {
    findings.push(`compose is missing the ${key} service`);
    continue;
  }
  const text = block[0];
  if (!/restart:/.test(text)) findings.push(`compose ${key}: no restart policy`);
  if (!/healthcheck:/i.test(text) && key === 'api') {
    findings.push('compose api: no healthcheck block');
  }
  // Secrets must be injected, never hardcoded.
  const inline = /[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD)\w*:\s*['"][^'"$]{8,}/.exec(text);
  if (inline) {
    findings.push(`compose ${key}: hardcoded secret ${inline[0].split(':')[0].trim()}`);
  }
}

// No `container_name`: collides across environments.
if (/container_name:/.test(compose)) {
  notes.push('compose sets container_name, which blocks parallel staging + production stacks');
}

// ---- report --------------------------------------------------------------
console.log(`Stages: ${stages.map((s) => s.as ?? s.from).join(' -> ')}`);
console.log(`Findings: ${findings.length}`);
for (const f of findings) console.log(`  FAIL  ${f}`);
for (const n of notes) console.log(`  note  ${n}`);
process.exitCode = findings.length > 0 ? 1 : 0;
