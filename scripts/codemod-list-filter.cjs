/**
 * One-off codemod: wrap bare filter objects in `.list({ ... })` calls so they
 * become `.list({ filter: { ... } })`.
 *
 * The repository API is `table.list({ filter, order, limit, offset })`. A handful
 * of call sites passed the filter at the top level. This rewrites them
 * structurally (brace-matched) rather than with a fragile regex.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGES = ['core', 'booking', 'billing', 'checkin', 'api', 'shared'];
const RESERVED = new Set(['filter', 'order', 'limit', 'offset']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Returns the index just past the object literal starting at `start` (which is `{`). */
/** Strips a trailing `as Filter` / `as never` cast that the wrap left behind. */
function unwrapCast(body) {
  const trimmed = body.trim();
  const cast = /\s+as\s+(?:const|never|Filter|Record<[^>]*>|unknown)\s*$/.exec(trimmed);
  return cast ? trimmed.slice(0, cast.index) : trimmed;
}

function matchBraces(src, start) {
  let depth = 0;
  let i = start;
  let inString = null;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 1;
    } else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** Top-level keys of an object literal body. */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let inString = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ':' && depth === 0) {
      keys.push(current.trim());
      current = '';
      continue;
    }
    if (ch === ',' && depth === 0) {
      if (current.trim()) keys.push(current.trim());
      current = '';
      continue;
    }
    if (!/\s/.test(ch) || depth > 0) current += ch;
  }
  if (current.trim()) keys.push(current.trim());
  return keys;
}

let totalEdits = 0;
const touched = [];

for (const pkg of PACKAGES) {
  const srcDir = path.join(ROOT, 'packages', pkg, 'src');
  if (!fs.existsSync(srcDir)) continue;

  for (const file of walk(srcDir)) {
    const original = fs.readFileSync(file, 'utf8');
    let src = original;
    let changed = 0;
    let cursor = 0;

    for (;;) {
      const next = ['.list(', '.findOne(', '.count(']
        .map((token) => ({ token, at: src.indexOf(token + '{', cursor) }))
        .filter((entry) => entry.at !== -1)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      const call = next.at;
      const braceIndex = call + next.token.length;
      const end = matchBraces(src, braceIndex);
      if (end === -1) {
        cursor = call + next.token.length;
        continue;
      }
      const body = src.slice(braceIndex + 1, end - 1);
      const keys = topLevelKeys(body);
      const alreadyWrapped = keys.some((key) => RESERVED.has(key));

      if (!alreadyWrapped && body.trim().length > 0) {
        const indent = src.slice(src.lastIndexOf('\n', call) + 1, call).length;
        const pad = ' '.repeat(indent);
        const clean = unwrapCast(body);
        const multiline = clean.includes('\n');
        const replacement = multiline
          ? `{\n${pad}  filter: {${clean}\n${pad}},\n${pad}}`
          : `{ filter: {${clean}} }`;
        src = src.slice(0, braceIndex) + replacement + src.slice(end);
        changed += 1;
        cursor = braceIndex + replacement.length;
      } else {
        cursor = end;
      }
    }

    if (changed > 0) {
      fs.writeFileSync(file, src);
      totalEdits += changed;
      touched.push(`${path.relative(ROOT, file)} (${changed})`);
    }
  }
}

console.log(`Rewrote ${totalEdits} repository query call(s) in ${touched.length} file(s):`);
for (const entry of touched) console.log(`  ${entry}`);