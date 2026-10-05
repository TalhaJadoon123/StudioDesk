import { AppError, newInvoiceId, newLineItemId, type Currency, type Invoice, type InvoiceLineItem } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { invoiceNumber } from './stripe.js';

export function invoicesRepo(ctx: CoreContext) {
  return ctx.repo.table('invoices');
}

/** Business-rule violations must map to 4xx, not 500. */
function rule(code: 'conflict' | 'not_found' | 'validation_failed', message: string): Error {
  return new AppError(code, message);
}

export interface DraftLineItem {
  description: string;
  quantity?: number;
  unitAmountCents: number;
  kind: InvoiceLineItem['kind'];
  metadata?: Record<string, string | number>;
}

export interface CreateInvoiceInput {
  memberId?: string;
  lineItems: DraftLineItem[];
  currency?: Currency;
  dueInDays?: number;
  /** Emit `invoice.created` / `invoice.paid` domain events. */
  notify?: boolean;
  /** Reference used to keep the invoice number stable across retries. */
  reference?: string;
}

function buildLineItems(items: DraftLineItem[]): InvoiceLineItem[] {
  return items.map((item) => {
    const quantity = item.quantity ?? 1;
    return {
      id: newLineItemId(),
      description: item.description,
      quantity,
      unitAmountCents: item.unitAmountCents,
      amountCents: quantity * item.unitAmountCents,
      kind: item.kind,
      metadata: item.metadata,
    };
  });
}

/**
 * Creates an invoice. `amountDueCents` is derived, so callers cannot get the
 * arithmetic wrong. Fees are added as separate line items so the member can see
 * exactly why their balance changed.
 */
export async function createInvoice(ctx: CoreContext, input: CreateInvoiceInput): Promise<Invoice> {
  if (!input.lineItems.length) throw rule('validation_failed', 'Cannot create an invoice with no line items');

  const lineItems = buildLineItems(input.lineItems);
  const subtotalCents = lineItems.reduce((acc, item) => acc + item.amountCents, 0);
  const at = ctx.now().toISOString();
  const sequence = (await invoicesRepo(ctx).count()) + 1;

  const invoice: Invoice = {
    id: newInvoiceId(),
    studioId: ctx.studioId,
    memberId: input.memberId,
    number: input.reference ?? invoiceNumber(sequence),
    status: 'open',
    currency: input.currency ?? 'usd',
    subtotalCents,
    taxCents: 0,
    discountCents: 0,
    totalCents: subtotalCents,
    amountPaidCents: 0,
    amountDueCents: subtotalCents,
    lineItems,
    dueAt: new Date(Date.parse(at) + (input.dueInDays ?? 14) * 86_400_000).toISOString(),
    createdAt: at,
    updatedAt: at,
  };

  const created = await invoicesRepo(ctx).insert(invoice);
  if (input.notify !== false) {
    await ctx.events.emit('invoice.created', {
      invoiceId: created.id,
      memberId: created.memberId,
      totalCents: created.totalCents,
    });
  }
  return created;
}

export async function addLineItem(
  ctx: CoreContext,
  invoiceId: string,
  item: DraftLineItem,
): Promise<Invoice> {
  const invoice = await requireInvoice(ctx, invoiceId);
  if (invoice.status === 'paid' || invoice.status === 'void') {
    throw rule('conflict', `Cannot add a line item to a ${invoice.status} invoice`);
  }
  const lineItems = [...invoice.lineItems, ...buildLineItems([item])];
  const subtotalCents = lineItems.reduce((acc, li) => acc + li.amountCents, 0);
  return invoicesRepo(ctx).update(invoiceId, {
    lineItems,
    subtotalCents,
    totalCents: subtotalCents + invoice.taxCents - invoice.discountCents,
    amountDueCents: subtotalCents + invoice.taxCents - invoice.discountCents - invoice.amountPaidCents,
    updatedAt: ctx.now().toISOString(),
  });
}

export async function markPaid(
  ctx: CoreContext,
  invoiceId: string,
  amountCents?: number,
): Promise<Invoice> {
  const invoice = await requireInvoice(ctx, invoiceId);
  const paid = amountCents ?? invoice.amountDueCents;
  const amountPaidCents = invoice.amountPaidCents + paid;
  const updated = await invoicesRepo(ctx).update(invoiceId, {
    status: 'paid',
    amountPaidCents,
    amountDueCents: Math.max(0, invoice.totalCents - amountPaidCents),
    paidAt: ctx.now().toISOString(),
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.events.emit('invoice.paid', {
    invoiceId,
    memberId: invoice.memberId,
    totalCents: paid,
  });
  return updated;
}

export async function voidInvoice(ctx: CoreContext, invoiceId: string, reason?: string): Promise<Invoice> {
  const invoice = await requireInvoice(ctx, invoiceId);
  if (invoice.status === 'paid') throw rule('conflict', 'Cannot void a paid invoice - refund it instead');
  const updated = await invoicesRepo(ctx).update(invoiceId, {
    status: 'void',
    amountDueCents: 0,
    updatedAt: ctx.now().toISOString(),
    lineItems: invoice.lineItems,
    ...(reason ? { description: reason } : {}),
  } as Partial<Invoice>);
  return updated;
}

export async function getInvoice(ctx: CoreContext, id: string): Promise<Invoice | null> {
  return invoicesRepo(ctx).findById(id);
}

export async function requireInvoice(ctx: CoreContext, id: string): Promise<Invoice> {
  const invoice = await getInvoice(ctx, id);
  if (!invoice) throw rule('not_found', `Invoice ${id} not found`);
  return invoice;
}

export async function listInvoices(
  ctx: CoreContext,
  query: { memberId?: string; status?: Invoice['status']; limit?: number } = {},
): Promise<Invoice[]> {
  const filter: Record<string, unknown> = {};
  if (query.memberId) filter.memberId = query.memberId;
  if (query.status) filter.status = query.status;
  const rows = await invoicesRepo(ctx).list({ filter: filter as never });
  const sorted = rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return query.limit ? sorted.slice(0, query.limit) : sorted;
}

export async function outstandingBalance(ctx: CoreContext, memberId: string): Promise<number> {
  const invoices = await listInvoices(ctx, { memberId, status: 'open' });
  return invoices.reduce((acc, invoice) => acc + invoice.amountDueCents, 0);
}

export async function openInvoicesFor(ctx: CoreContext, memberId: string): Promise<Invoice[]> {
  return listInvoices(ctx, { memberId, status: 'open' });
}

/** Adds outstanding fees/dues to one consolidated invoice for a member. */
export async function consolidateBalance(ctx: CoreContext, memberId: string): Promise<Invoice | null> {
  const fees = await ctx.repo.table('fees').list({ filter: { memberId, status: 'assessed' } });
  if (!fees.length) return null;

  const existing = (await openInvoicesFor(ctx, memberId))[0];
  const item: DraftLineItem = {
    description: `${fees.length} outstanding charge(s)`,
    quantity: 1,
    unitAmountCents: fees.reduce((acc, fee) => acc + fee.amountCents, 0),
    kind: fees[0]!.kind === 'no-show' ? 'no-show-fee' : 'late-cancel-fee',
    metadata: { feeIds: fees.map((f) => f.id).join(',') },
  };

  const invoice = existing
    ? await addLineItem(ctx, existing.id, item)
    : await createInvoice(ctx, { memberId, lineItems: [item] });

  for (const fee of fees) {
    await ctx.repo.table('fees').update(fee.id, { status: 'charged', chargedAt: ctx.now().toISOString() });
  }
  return invoice;
}

/** Plain-text invoice, used for the email body and the PDF fallback. */
export function renderInvoiceText(invoice: Invoice, studioName = 'StudioDesk Studio'): string {
  const money = (cents: number) => `${invoice.currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
  const lines = invoice.lineItems
    .map(
      (item) =>
        `  ${item.description}${item.quantity > 1 ? ` x${item.quantity}` : ''}  ${money(item.amountCents)}`,
    )
    .join('\n');
  return [
    studioName,
    `Invoice ${invoice.number}`,
    '',
    lines,
    '',
    `Subtotal: ${money(invoice.subtotalCents)}`,
    invoice.discountCents ? `Discount: -${money(invoice.discountCents)}` : '',
    invoice.taxCents ? `Tax: ${money(invoice.taxCents)}` : '',
    `Total: ${money(invoice.totalCents)}`,
    invoice.amountPaidCents ? `Paid: ${money(invoice.amountPaidCents)}` : '',
    invoice.amountDueCents ? `Due: ${money(invoice.amountDueCents)}` : '',
    '',
    `Status: ${invoice.status}`,
    invoice.dueAt ? `Due by: ${invoice.dueAt.slice(0, 10)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}