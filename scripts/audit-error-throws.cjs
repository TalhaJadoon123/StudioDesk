// Reports remaining plain `throw new Error(...)` in the billing package so
// business-rule violations can be mapped to 4xx rather than 500.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'packages', 'billing', 'src');
let total = 0;

for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith('.ts')) continue;
  const full = path.join(dir, file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const hits = [];
  lines.forEach((line, index) => {
    if (line.includes('throw new Error(')) hits.push(`${index + 1}: ${line.trim()}`);
  });
  if (hits.length) {
    console.log(`${file}`);
    for (const hit of hits) console.log(`  ${hit}`);
    total += hits.length;
  }
}
console.log(`\n${total} plain Error throw(s) in billing.`);
