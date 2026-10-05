/**
 * @studiodesk/billing - memberships, packs, drop-ins, fees, dunning,
 * invoices (text + PDF) and the payment gateway adapters.
 */

export * from './gateway.js';
export * from './stripe.js';
export * from './invoices.js';
export * from './class-packs.js';
export * from './drop-ins.js';
export * from './fees.js';
export * from './dunning.js';
export * from './memberships.js';
export * from './email.js';
export * from './invoice-pdf.js';

import type { CoreContext, StudioDesk } from '@studiodesk/core';
import * as gateway from './gateway.js';
import * as invoices from './invoices.js';
import * as classPacks from './class-packs.js';
import * as dropIns from './drop-ins.js';
import * as fees from './fees.js';
import * as dunning from './dunning.js';
import * as memberships from './memberships.js';
import * as email from './email.js';
import * as stripe from './stripe.js';
import { connectFees } from './fees.js';

export interface BillingModule {
  gateway: typeof gateway;
  stripe: typeof stripe;
  invoices: typeof invoices;
  packs: typeof classPacks;
  dropIns: typeof dropIns;
  fees: typeof fees;
  dunning: typeof dunning;
  memberships: typeof memberships;
  email: typeof email;
}

export function createBillingModule(_ctx?: CoreContext | StudioDesk): BillingModule {
  return { gateway, stripe, invoices, packs: classPacks, dropIns, fees, dunning, memberships, email };
}

export const billing = {
  gateway,
  stripe,
  invoices,
  packs: classPacks,
  dropIns,
  fees,
  dunning,
  memberships,
  email,
};

// Named namespaces so consumers can `import { memberships } from '@studiodesk/billing'`.
export { gateway, stripe, invoices, classPacks as packs, dropIns, fees, dunning, memberships, email };

export interface BillingRuntime {
  gateways: ReturnType<typeof gateway.createGateways>;
  fees: ReturnType<typeof connectFees>;
}

/**
 * Boots billing for a studio: picks the gateways from the environment and
 * connects fee assessment to booking/class events. Call once at server start.
 */
export function connectBilling(
  ctx: CoreContext,
  options: { autoChargeFees?: boolean } = {},
): BillingRuntime {
  const gateways = gateway.createGateways();
  const feeHandle = connectFees(ctx, gateways.oneOff, { autoCharge: options.autoChargeFees === true });
  return { gateways, fees: feeHandle };
}

export type { SubscriberHandle } from './gateway.js';