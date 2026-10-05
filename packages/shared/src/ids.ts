/**
 * Id generation that works in Node, the browser, Expo and Cloudflare Workers
 * (all expose `crypto`; Node 20+ exposes `crypto.randomUUID` globally).
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

type Entropy = { getRandomValues<T extends ArrayBufferView>(array: T): T };

function entropy(): Entropy {
  const g = globalThis as unknown as { crypto?: Entropy };
  if (!g.crypto || typeof g.crypto.getRandomValues !== 'function') {
    throw new Error('No CSPRNG available - Node 20+, a secure browser context or Workers required');
  }
  return g.crypto;
}

export function randomId(size = 21): string {
  const bytes = new Uint8Array(size);
  entropy().getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Prefixed, sortable-ish id: `mem_lq3x8f_9f2a...`. */
export function prefixedId(prefix: string, size = 16): string {
  return `${prefix}_${randomId(size)}`;
}

export const newStudioId = () => prefixedId('std');
export const newMemberId = () => prefixedId('mem');
export const newInstructorId = () => prefixedId('ins');
export const newClassId = () => prefixedId('cls');
export const newClassOccurrenceId = () => prefixedId('occ');
export const newBookingId = () => prefixedId('bkg');
export const newInvoiceId = () => prefixedId('inv');
export const newLineItemId = () => prefixedId('li');
export const newChargeId = () => prefixedId('chg');
export const newMembershipId = () => prefixedId('mbs');
export const newPackId = () => prefixedId('pak');
export const newDropInId = () => prefixedId('dip');
export const newFeeId = () => prefixedId('fee');
export const newAttendanceId = () => prefixedId('att');
export const newNotificationId = () => prefixedId('ntf');
export const newSeriesId = () => prefixedId('ser');
export const newDeviceId = () => prefixedId('dev');
export const newEventId = () => prefixedId('evt');

export function isPrefixed(id: string, prefix: string): boolean {
  return id.startsWith(`${prefix}_`);
}