/**
 * Generates a PDF invoice from the command line.
 *
 *   npm run invoice:pdf -- --invoice=inv_xxx --out=invoice.pdf
 *   npm run invoice:pdf -- --demo --out=demo.pdf
 *
 * With no invoice id, a small demo invoice is rendered so the PDF path can be
 * checked without touching the database.
 */
import { writeFile } from 'node:fs/promises';
import { createContext, seedDemoStudio } from '@studiodesk/core';
import { invoiceToPdf } from '../invoice-pdf.js';

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

async function main(): Promise<void> {
  const out = arg('out', 'invoice.pdf')!;
  const demo = process.argv.includes('--demo') || !arg('invoice');

  const ctx = createContext();
  let invoice;

  if (demo) {
    const { createInvoice, markPaid } = await import('../invoices.js');
    const draft = await createInvoice(ctx, {
      memberId: 'mem_demo',
      lineItems: [
        { description: 'Unlimited Monthly membership', quantity: 1, unitAmountCents: 8900, kind: 'membership' },
        { description: '10 Class Pack', quantity: 1, unitAmountCents: 15000, kind: 'class-pack' },
        { description: 'No-show fee (Vinyasa Flow)', quantity: 1, unitAmountCents: 500, kind: 'no-show-fee' },
      ],
    });
    invoice = await markPaid(ctx, draft.id);
  } else {
    const { invoices } = await import('../invoices.js');
    invoice = await invoices.requireInvoice(ctx, arg('invoice')!);
  }

  const pdf = await invoiceToPdf({
    invoice,
    studioName: arg('studio', 'Riverbend Yoga'),
    memberName: arg('member', 'Ada Lovelace'),
    memberEmail: arg('email'),
  });

  await writeFile(out, Buffer.from(pdf.base64, 'base64'));

  console.log(`\n  Invoice ${invoice.number}`);
  console.log(`  Total   : ${(invoice.totalCents / 100).toFixed(2)}`);
  console.log(`  Renderer: ${pdf.generator}`);
  console.log(`  Written : ${out}\n`);
  if (pdf.generator === 'text') {
    console.log('  Note: pdfme is not installed, so the text fallback was written.');
    console.log('  Run `npm run setup:web` to add it.\n');
  }

  void seedDemoStudio;
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
