/**
 * Generates a PDF invoice from the command line.
 *
 *   npm run invoice:pdf -- --demo --out=demo.pdf
 *   npm run invoice:pdf -- --invoice=inv_xxx --out=invoice.pdf
 *
 * With no invoice id a small demo invoice is rendered, so the PDF path can be
 * checked without touching the database.
 */
import { writeFile } from 'node:fs/promises';
import { createContext } from '@studiodesk/core';
import type { Invoice } from '@studiodesk/shared';
import { createInvoice, markPaid, requireInvoice } from '../invoices.js';
import { invoiceToPdf } from '../invoice-pdf.js';

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

async function write(out: string, invoice: Invoice): Promise<void> {
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
}

async function main(): Promise<void> {
  const out = arg('out', 'invoice.pdf')!;
  const invoiceId = arg('invoice');
  const ctx = createContext();

  if (invoiceId) {
    await write(out, await requireInvoice(ctx, invoiceId));
    return;
  }

  // Demo invoice so the PDF path can be verified with no database.
  const draft = await createInvoice(ctx, {
    memberId: 'mem_demo',
    lineItems: [
      { description: 'Unlimited Monthly membership', quantity: 1, unitAmountCents: 8900, kind: 'membership' },
      { description: '10 Class Pack', quantity: 1, unitAmountCents: 15000, kind: 'class-pack' },
      { description: 'No-show fee (Vinyasa Flow)', quantity: 1, unitAmountCents: 500, kind: 'no-show-fee' },
    ],
  });
  await write(out, await markPaid(ctx, draft.id));
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
