// Converts business-rule `throw new Error(...)` calls in the billing package
// into typed `AppError`s, so the API maps them to 4xx instead of 500.
//
// Replacements are matched literally; anything not listed is left alone (e.g.
// genuinely unexpected failures in the email transport).
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'packages', 'billing', 'src');

/** @type {Array<[file: string, from: string, to: string]>} */
const REPLACEMENTS = [
  // ---- class-packs.ts
  ['class-packs.ts', "throw new Error(`Member ${input.memberId} not found`)", "throw rule('not_found', `Member ${input.memberId} not found`)"],
  ['class-packs.ts', "throw new Error(`${member.name}'s membership is cancelled`)", "throw rule('conflict', `${member.name}'s membership is cancelled`)"],
  ['class-packs.ts', "throw new Error('A class pack must contain at least one credit')", "throw rule('validation_failed', 'A class pack must contain at least one credit')"],
  ['class-packs.ts', 'throw new Error(`Pack ${packId} not found`)', "throw rule('not_found', `Pack ${packId} not found`)"],

  // ---- drop-ins.ts
  ['drop-ins.ts', "throw new Error(`Member ${input.memberId} not found`)", "throw rule('not_found', `Member ${input.memberId} not found`)"],
  ['drop-ins.ts', "throw new Error(`Class ${input.classId} not found`)", "throw rule('not_found', `Class ${input.classId} not found`)"],
  ['drop-ins.ts', "throw new Error(`${klass.name} has been cancelled`)", "throw rule('conflict', `${klass.name} has been cancelled`)"],
  ['drop-ins.ts', 'throw new Error(`Drop-in ${dropInId} not found`)', "throw rule('not_found', `Drop-in ${dropInId} not found`)"],

  // ---- dunning.ts
  ['dunning.ts', "throw new Error(`Membership ${input.membershipId} not found`)", "throw rule('not_found', `Membership ${input.membershipId} not found`)"],
  ['dunning.ts', 'throw new Error(`Membership ${membershipId} not found`)', "throw rule('not_found', `Membership ${membershipId} not found`)"],

  // ---- fees.ts
  ['fees.ts', "throw new Error(`Member ${input.memberId} not found`)", "throw rule('not_found', `Member ${input.memberId} not found`)"],
  ['fees.ts', 'throw new Error(`Fee ${feeId} not found`)', "throw rule('not_found', `Fee ${feeId} not found`)"],

  // ---- invoices.ts
  ['invoices.ts', "throw new Error('Cannot create an invoice with no line items')", "throw rule('validation_failed', 'Cannot create an invoice with no line items')"],
  ['invoices.ts', 'throw new Error(`Cannot add a line item to a ${invoice.status} invoice`)', "throw rule('conflict', `Cannot add a line item to a ${invoice.status} invoice`)"],
  ['invoices.ts', "throw new Error('Cannot void a paid invoice - refund it instead')", "throw rule('conflict', 'Cannot void a paid invoice - refund it instead')"],
  ['invoices.ts', 'throw new Error(`Invoice ${id} not found`)', "throw rule('not_found', `Invoice ${id} not found`)"],
];

let applied = 0;
const touched = new Set();

for (const [file, from, to] of REPLACEMENTS) {
  const full = path.join(dir, file);
  let source = fs.readFileSync(full, 'utf8');
  if (!source.includes(from)) continue;
  source = source.split(from).join(to);
  fs.writeFileSync(full, source);
  applied += 1;
  touched.add(file);
}

console.log(`Applied ${applied} replacement(s) across ${touched.size} file(s).`);
