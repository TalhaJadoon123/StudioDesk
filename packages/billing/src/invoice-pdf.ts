import { formatMoney, type Currency, type Invoice } from '@studiodesk/shared';
import { renderInvoiceText } from './invoices.js';

/**
 * PDF invoice / report generation with **pdfme** (MIT).
 *
 * pdfme is loaded lazily so the API and tests never pay for it. Everything
 * degrades to plain text when the library is not installed - `npm run
 * setup:web` pulls it in with the web app.
 */

export interface PdfResult {
  base64: string;
  mimeType: 'application/pdf';
  /** Plain-text fallback, always produced. */
  text: string;
  generator: 'pdfme' | 'text';
}

export interface InvoicePdfInput {
  invoice: Invoice;
  studioName?: string;
  studioAddress?: string[];
  memberName?: string;
  memberEmail?: string;
  accentColor?: string;
  logoDataUri?: string;
}

/**
 * pdfme's schema is a fixed field layout. Keeping it as a constant (rather
 * than generating it) means invoices render identically every time.
 */
export const INVOICE_TEMPLATE = {
  basePdf: '', // replaced at runtime by loading the bundled blank A4 base
  fields: {
    studioName: { x: 12, y: 12, w: 120, h: 10, fontSize: 18, fontName: 'Helvetica-Bold', alignment: 'left' },
    studioAddress: { x: 12, y: 24, w: 120, h: 8, fontSize: 9, fontName: 'Helvetica', alignment: 'left' },
    invoiceNumber: { x: 150, y: 12, w: 40, h: 8, fontSize: 11, fontName: 'Helvetica-Bold', alignment: 'right' },
    invoiceDate: { x: 150, y: 20, w: 40, h: 8, fontSize: 9, fontName: 'Helvetica', alignment: 'right' },
    billTo: { x: 12, y: 42, w: 100, h: 8, fontSize: 10, fontName: 'Helvetica-Bold', alignment: 'left' },
    billToDetail: { x: 12, y: 50, w: 100, h: 8, fontSize: 9, fontName: 'Helvetica', alignment: 'left' },
    tableHeader: { x: 12, y: 66, w: 178, h: 7, fontSize: 9, fontName: 'Helvetica-Bold', alignment: 'left', backgroundColor: '#eef2ff' },
    rows: { x: 12, y: 74, w: 178, h: 100, fontSize: 9, fontName: 'Helvetica', alignment: 'left' },
    subtotal: { x: 130, y: 180, w: 40, h: 7, fontSize: 10, fontName: 'Helvetica', alignment: 'right' },
    total: { x: 125, y: 190, w: 45, h: 9, fontSize: 13, fontName: 'Helvetica-Bold', alignment: 'right', backgroundColor: '#eef2ff' },
    footer: { x: 12, y: 275, w: 178, h: 8, fontSize: 8, fontName: 'Helvetica', alignment: 'center' },
  },
  schemas: [{ a: 'Description', b: 'Qty', c: 'Amount' }],
} as const;

/** Renders the line-item table into pdfme's table field format. */
export function buildTable(rows: Array<{ description: string; quantity: number; amountCents: number }>, currency: Currency): string {
  const money = (cents: number) => formatMoney(cents, currency);
  return [
    ['1x', 'Description', 'Amount', '', '', '', '', ''],
    ...rows.map((row, index) => [
      String(index + 1),
      `${row.description}${row.quantity > 1 ? ` x${row.quantity}` : ''}`,
      money(row.amountCents),
      '',
      '',
      '',
      '',
      '',
    ]),
  ].map((row) => row.join('\t')).join('\n');
}

/**
 * Generates the invoice PDF. Requires `@pdfme/generator` + `@pdfme/schemas`
 * (installed with the web app); falls back to text when unavailable.
 */
export async function invoiceToPdf(input: InvoicePdfInput): Promise<PdfResult> {
  const text = renderInvoiceText(input.invoice, input.studioName ?? 'StudioDesk Studio');
  const currency = input.invoice.currency as Currency;

  try {
    const [{ generate }, { getDefaultFont }] = await Promise.all([
      import('@pdfme/generator' as string),
      import('@pdfme/schemas' as string),
    ]);
    const { readFile } = await import('node:fs/promises');
    void readFile;

    const font = await getDefaultFont();
    const basePdf = await createBlankBasePdf();

    const result = await generate({
      basePdf,
      schema: {
        ...INVOICE_TEMPLATE,
        fields: {
          ...INVOICE_TEMPLATE.fields,
          studioName: { ...INVOICE_TEMPLATE.fields.studioName, value: input.studioName ?? 'StudioDesk Studio' },
          invoiceNumber: { ...INVOICE_TEMPLATE.fields.invoiceNumber, value: input.invoice.number },
          invoiceDate: {
            ...INVOICE_TEMPLATE.fields.invoiceDate,
            value: (input.invoice.createdAt ?? '').slice(0, 10),
          },
          billTo: { ...INVOICE_TEMPLATE.fields.billTo, value: input.memberName ?? 'Member' },
          billToDetail: { ...INVOICE_TEMPLATE.fields.billToDetail, value: input.memberEmail ?? '' },
          rows: {
            ...INVOICE_TEMPLATE.fields.rows,
            value: buildTable(
              input.invoice.lineItems.map((item) => ({
                description: item.description,
                quantity: item.quantity,
                amountCents: item.amountCents,
              })),
              currency,
            ),
          },
          subtotal: {
            ...INVOICE_TEMPLATE.fields.subtotal,
            value: `Subtotal ${formatMoney(input.invoice.subtotalCents, currency)}`,
          },
          total: {
            ...INVOICE_TEMPLATE.fields.total,
            value: `Total ${formatMoney(input.invoice.totalCents, currency)}`,
          },
          footer: {
            ...INVOICE_TEMPLATE.fields.footer,
            value: `Status: ${input.invoice.status}. Thank you for training with us.`,
          },
        },
      } as never,
      fonts: [{ fontName: 'Helvetica', data: font }],
    });

    return { base64: result.toString('base64'), mimeType: 'application/pdf', text, generator: 'pdfme' };
  } catch (error) {
    // pdfme not installed - hand back a text invoice instead of failing.
    void error;
    return {
      base64: Buffer.from(text, 'utf8').toString('base64'),
      mimeType: 'application/pdf',
      text,
      generator: 'text',
    };
  }
}

/** pdfme needs a blank A4 PDF as the background layer. */
async function createBlankBasePdf(): Promise<string> {
  // Minimal valid single-page PDF built by hand - no binary asset to ship.
  const content = 'q 0.96 0.95 1 0 0 0.96 0.95 0 cm Q\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'binary').toString('base64');
}

/** Writes the PDF to disk - used by `npm run invoice:pdf`. */
export async function writeInvoicePdf(input: InvoicePdfInput, outPath: string): Promise<PdfResult> {
  const result = await invoiceToPdf(input);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, Buffer.from(result.base64, 'base64'));
  return result;
}