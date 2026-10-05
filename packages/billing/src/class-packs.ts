import { AppError, addDays, newPackId, sortBy, toCents, type ClassPack } from '@studiodesk/shared';
import type { CoreContext } from '@studiodesk/core';
import { creditBalance } from '@studiodesk/core';
import { createInvoice, markPaid, type DraftLineItem } from './invoices.js';
import { chargeKey } from './stripe.js';
import type { PaymentGateway } from './gateway.js';

export function packsRepo(ctx: CoreContext) {
  return ctx.repo.table('packs');
}

/** Business-rule violations must map to 4xx, not 500. See `errors.ts`. */
function rule(
  code: 'conflict' | 'not_found' | 'validation_failed' | 'payment_failed',
  message: string,
): Error {
  return new AppError(code, message);
}

/** Price list a studio can sell. Studios can override the amounts freely. */
export const PACK_CATALOGUE: Array<{ name: string; credits: number; priceCents: number; description: string }> = [
  { name: '5 Class Pack', credits: 5, priceCents: 9_000, description: '$18 a class. Good for occasional visitors.' },
  { name: '10 Class Pack', credits: 10, priceCents: 15_000, description: '$15 a class. Our most popular pack.' },
  { name: '20 Class Pack', credits: 20, priceCents: 27_000, description: '$13.50 a class. Best value.' },
];

export function findPackSpec(nameOrCredits: string | number) {
  if (typeof nameOrCredits === 'number') {
    return PACK_CATALOGUE.find((spec) => spec.credits === nameOrCredits);
  }
  return PACK_CATALOGUE.find((spec) => spec.name.toLowerCase() === nameOrCredits.toLowerCase());
}

export interface PurchasePackInput {
  memberId: string;
  /** Catalogue name, exact credit count, or an explicit custom pack. */
  packName?: string;
  credits?: number;
  priceCents?: number;
  name?: string;
  currency?: ClassPack['currency'];
  expiresInDays?: number;
  /** Charge through the gateway. `false` records a cash/desk sale. */
  charge?: boolean;
  gateway?: PaymentGateway;
  idempotencyKey?: string;
  /** Grant without billing (complimentary, staff correction). */
  complimentary?: boolean;
}

export interface PurchasePackResult {
  pack: ClassPack;
  invoiceId?: string;
  charged: boolean;
  paymentId?: string;
  amountCents: number;
}

/**
 * Sells a class pack: creates the pack, invoices the member and (optionally)
 * charges the card. Pack credits are granted on success, never before, so a
 * failed payment cannot hand out free classes.
 */
export async function purchasePack(
  ctx: CoreContext,
  input: PurchasePackInput,
): Promise<PurchasePackResult> {
  const member = await ctx.repo.table('members').findById(input.memberId);
  if (!member) throw rule('not_found', `Member ${input.memberId} not found`);
  if (member.status === 'cancelled') throw rule('conflict', `${member.name}'s membership is cancelled`);

  const spec =
    input.name && input.credits
      ? { name: input.name, credits: input.credits, priceCents: input.priceCents ?? 0, description: '' }
      : input.packName
        ? findPackSpec(input.packName)
        : input.credits
          ? findPackSpec(input.credits)
          : undefined;

  const name = input.name ?? spec?.name ?? `${input.credits ?? 0} Class Pack`;
  const credits = input.credits ?? spec?.credits ?? 0;
  if (credits <= 0) throw rule('validation_failed', 'A class pack must contain at least one credit');
  const priceCents = input.priceCents ?? spec?.priceCents ?? 0;
  const currency = input.currency ?? member.currency ?? 'usd';

  const at = ctx.now();
  const expiresAt = addDays(at, input.expiresInDays ?? 90).toISOString();

  const invoice = await createInvoice(ctx, {
    memberId: member.id,
    currency,
    lineItems: [
      {
        description: `${name} (${credits} credits)`,
        quantity: 1,
        unitAmountCents: priceCents,
        kind: 'class-pack',
        metadata: { credits },
      },
    ],
  });

  let paymentId: string | undefined;
  let charged = false;

  if (priceCents > 0 && !input.complimentary) {
    if (input.gateway) {
      const payment = await input.gateway.createPayment({
        amountCents: priceCents,
        currency,
        description: `${name} - ${member.name}`,
        memberId: member.id,
        idempotencyKey: input.idempotencyKey ?? chargeKey('class-pack', member.id, invoice.id),
        metadata: { memberId: member.id, invoiceId: invoice.id, kind: 'class-pack' },
      });
      paymentId = payment.id;
      if (payment.status === 'failed') {
        await ctx.events.emit('payment.failed', {
          chargeId: payment.id,
          memberId: member.id,
          failureCode: payment.failureCode,
        });
        return { pack: undefined as never, invoiceId: invoice.id, charged: false, paymentId, amountCents: priceCents };
      }
      await markPaid(ctx, invoice.id, priceCents);
      charged = payment.status === 'succeeded';
    } else {
      // Desk sale: mark paid and move on.
      await markPaid(ctx, invoice.id, priceCents);
      charged = true;
    }
  } else {
    await markPaid(ctx, invoice.id, 0);
  }

  const pack = await packsRepo(ctx).insert({
    id: newPackId(),
    studioId: ctx.studioId,
    memberId: member.id,
    name,
    credits,
    creditsRemaining: credits,
    priceCents,
    currency,
    purchasedAt: at.toISOString(),
    expiresAt,
    status: 'active',
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
  });

  await ctx.events.emit('pack.purchased', { packId: pack.id, memberId: member.id, credits });
  return { pack, invoiceId: invoice.id, charged, paymentId, amountCents: priceCents };
}

export async function grantCredits(
  ctx: CoreContext,
  input: { memberId: string; credits: number; name?: string; expiresInDays?: number; note?: string },
): Promise<ClassPack> {
  const pack = await packsRepo(ctx).insert({
    id: newPackId(),
    studioId: ctx.studioId,
    memberId: input.memberId,
    name: input.name ?? 'Studio credit',
    credits: input.credits,
    creditsRemaining: input.credits,
    priceCents: 0,
    currency: 'usd',
    purchasedAt: ctx.now().toISOString(),
    expiresAt: input.expiresInDays
      ? addDays(ctx.now(), input.expiresInDays).toISOString()
      : undefined,
    status: 'active',
    createdAt: ctx.now().toISOString(),
    updatedAt: ctx.now().toISOString(),
  });
  await ctx.events.emit('pack.purchased', {
    packId: pack.id,
    memberId: input.memberId,
    credits: input.credits,
  });
  return pack;
}

/** Manual top-up onto an existing pack. */
export async function topUpPack(
  ctx: CoreContext,
  packId: string,
  credits: number,
): Promise<ClassPack> {
  const pack = await packsRepo(ctx).findById(packId);
  if (!pack) throw rule('not_found', `Pack ${packId} not found`);
  return packsRepo(ctx).update(packId, {
    credits: pack.credits + credits,
    creditsRemaining: pack.creditsRemaining + credits,
    status: 'active',
    expiresAt: addDays(ctx.now(), 90).toISOString(),
    updatedAt: ctx.now().toISOString(),
  });
}

export async function refundPack(ctx: CoreContext, packId: string, credits: number): Promise<ClassPack> {
  const pack = await packsRepo(ctx).findById(packId);
  if (!pack) throw rule('not_found', `Pack ${packId} not found`);
  const creditsRemaining = Math.max(0, pack.creditsRemaining - credits);
  return packsRepo(ctx).update(packId, {
    creditsRemaining,
    status: creditsRemaining > 0 ? 'active' : 'depleted',
    updatedAt: ctx.now().toISOString(),
  });
}

export async function listPacks(
  ctx: CoreContext,
  query: { memberId?: string; status?: ClassPack['status'] } = {},
): Promise<ClassPack[]> {
  const filter: Record<string, unknown> = {};
  if (query.memberId) filter.memberId = query.memberId;
  if (query.status) filter.status = query.status;
  const rows = await packsRepo(ctx).list({ filter: filter as never });
  return sortBy(rows, (p) => p.purchasedAt, 'desc');
}

/** Marks packs past their expiry. Safe to call on every request. */
export async function expirePacks(ctx: CoreContext): Promise<number> {
  const nowIso = ctx.now().toISOString();
  const packs = await packsRepo(ctx).list({ filter: { status: 'active' } });
  let expired = 0;
  for (const pack of packs) {
    if (pack.expiresAt && pack.expiresAt < nowIso) {
      await packsRepo(ctx).update(pack.id, { status: 'expired', updatedAt: nowIso });
      expired += 1;
    } else if (pack.creditsRemaining <= 0 && pack.status !== 'depleted') {
      await packsRepo(ctx).update(pack.id, { status: 'depleted', updatedAt: nowIso });
    }
  }
  return expired;
}

export interface PackHealth {
  memberId: string;
  totalCredits: number;
  usedCredits: number;
  packs: number;
  expiringSoon: Array<{ id: string; name: string; creditsRemaining: number; expiresAt: string; daysLeft: number }>;
  status: 'empty' | 'low' | 'healthy';
}

/** Credits on hand, with expiring-soon warnings for the member detail page. */
export async function packHealth(ctx: CoreContext, memberId: string): Promise<PackHealth> {
  const packs = await listPacks(ctx, { memberId, status: 'active' });
  const now = ctx.now().getTime();
  const expiringSoon = packs
    .filter((pack) => pack.expiresAt)
    .map((pack) => ({
      id: pack.id,
      name: pack.name,
      creditsRemaining: pack.creditsRemaining,
      expiresAt: pack.expiresAt!,
      daysLeft: Math.round((Date.parse(pack.expiresAt!) - now) / 86_400_000),
    }))
    .filter((pack) => pack.daysLeft <= 14)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const totalCredits = packs.reduce((acc, pack) => acc + pack.creditsRemaining, 0);
  return {
    memberId,
    totalCredits,
    usedCredits: packs.reduce((acc, pack) => acc + (pack.credits - pack.creditsRemaining), 0),
    packs: packs.length,
    expiringSoon,
    status: totalCredits === 0 ? 'empty' : totalCredits <= 2 ? 'low' : 'healthy',
  };
}

/** Members who are nearly out of credits - the pack-upsell list. */
export async function membersNeedingCredits(ctx: CoreContext, threshold = 2): Promise<string[]> {
  const members = await ctx.repo.table('members').list({ filter: { status: 'active' } });
  const out: string[] = [];
  for (const member of members) {
    const balance = await creditBalance(ctx, member.id);
    if (balance <= threshold) out.push(member.id);
  }
  return out;
}

export function packPriceFromDollars(dollars: number | string): number {
  return toCents(dollars);
}

export type { DraftLineItem };