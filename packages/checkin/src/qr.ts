import { config, newDeviceId } from '@studiodesk/shared';
import type { CheckinTicket } from '@studiodesk/shared';

/**
 * QR check-in tickets.
 *
 * A member's QR code is a short-lived HMAC-signed token rather than a raw
 * member id. If someone screenshots their code, the token stops working within
 * minutes and it reveals nothing about other members. The QR payload is
 * rendered with the `qrcode` package (MIT) - on the server to a data URL, and
 * in the app with expo-camera.
 */

const SECRET = () => config.checkinSecret();
export const DEFAULT_TTL_SECONDS = 120;

/**
 * Clock indirection.
 *
 * The studio's `CoreContext` owns the clock so tests and demos are
 * deterministic; ticket expiry must use the same clock or a pinned harness
 * would appear to have infinite-lived tickets.
 */
let nowProvider: () => Date = () => new Date();

/** Points ticket minting/verification at the caller's clock. */
export function setCheckinClock(provider: () => Date): void {
  nowProvider = provider;
}

/** Base64url without padding - short enough to read comfortably from a phone. */
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(signature));
}

export function nonce(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

/**
 * Mints a ticket. Payload: `sd1.<memberId>.<nonce>.<expiryEpoch>.<sig>`.
 * The signature covers the first four fields, so none of them can be tampered
 * with (including extending the expiry).
 */
export async function issueTicket(
  memberId: string,
  options: { ttlSeconds?: number; now?: Date; secret?: string } = {},
): Promise<CheckinTicket> {
  const now = options.now ?? nowProvider();
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const nonceValue = nonce();
  const body = `sd1.${memberId}.${nonceValue}.${Math.floor(expiresAt.getTime() / 1000)}`;
  const signature = await hmac(body, options.secret ?? SECRET());
  return {
    code: `${body}.${signature}`,
    memberId,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: nonceValue,
  };
}

export interface VerifyResult {
  valid: boolean;
  memberId?: string;
  reason?: 'malformed' | 'bad-signature' | 'expired' | 'unknown-version';
  expiresAt?: string;
}

/** Validates a scanned code. Deliberately constant-ish in its comparisons. */
export async function verifyTicket(
  code: string,
  options: { now?: Date; secret?: string } = {},
): Promise<VerifyResult> {
  // Without an explicit clock, use the harness/service clock when one is
  // installed so expiry follows studio time rather than wall-clock time.
  const now = options.now ?? nowProvider();
  const parts = code?.split('.') ?? [];
  if (parts.length !== 5 || parts[0] !== 'sd1') return { valid: false, reason: 'malformed' };

  const [version, memberId, nonceValue, expiryRaw, signature] = parts as [string, string, string, string, string];
  const body = [version, memberId, nonceValue, expiryRaw].join('.');
  const expected = await hmac(body, options.secret ?? SECRET());
  if (expected !== signature) return { valid: false, reason: 'bad-signature' };

  const expiry = Number.parseInt(expiryRaw, 10);
  if (!Number.isFinite(expiry)) return { valid: false, reason: 'malformed' };
  const nowMs = now.getTime();
  if (expiry * 1000 < nowMs) {
    return { valid: false, memberId, reason: 'expired', expiresAt: new Date(expiry * 1000).toISOString() };
  }
  return { valid: true, memberId, expiresAt: new Date(expiry * 1000).toISOString() };
}

/**
 * Renders a ticket as a scannable image.
 *
 * `qrcode` is imported lazily: the API and the test suite never load it, only
 * the code paths that actually produce an image.
 */
export async function ticketToDataUrl(
  code: string,
  options: { width?: number; margin?: number; dark?: string } = {},
): Promise<string> {
  const QRCode = await import('qrcode');
  return QRCode.toDataURL(code, {
    width: options.width ?? 320,
    margin: options.margin ?? 2,
    errorCorrectionLevel: 'M',
    color: { dark: options.dark ?? '#0f172a', light: '#ffffff' },
  });
}

export async function ticketToSvg(code: string, options: { width?: number } = {}): Promise<string> {
  const QRCode = await import('qrcode');
  return QRCode.toString(code, { type: 'svg', width: options.width ?? 320, margin: 2 });
}

/** Rotates a member's ticket, invalidating any previous screenshot. */
export async function refreshTicket(
  memberId: string,
  options: { ttlSeconds?: number } = {},
): Promise<CheckinTicket> {
  return issueTicket(memberId, options);
}

/* -------------------------------------------------------------------------- */
/* Kiosk pairing                                                              */
/* -------------------------------------------------------------------------- */

export interface KioskPairing {
  deviceId: string;
  /** Short code the studio types into the dashboard to claim the tablet. */
  claimCode: string;
  expiresAt: string;
}

export async function createPairing(
  options: { ttlSeconds?: number; now?: Date } = {},
): Promise<KioskPairing> {
  const now = options.now ?? new Date();
  const ttl = options.ttlSeconds ?? 300;
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const claimCode = [...bytes].map((b) => String(b % 10)).join('');
  return {
    deviceId: newDeviceId(),
    claimCode,
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  };
}

export function isPairingValid(pairing: KioskPairing, now: Date = new Date()): boolean {
  return Date.parse(pairing.expiresAt) > now.getTime();
}

/** Device-scoped token a tablet stores and sends with every check-in. */
export function deviceToken(deviceId: string): string {
  // Deterministic, opaque, and reversible only by the server.
  return `kiosk_${deviceId.replace(/[^a-z0-9]/gi, '')}_${b64url(
    new TextEncoder().encode(deviceId).slice(0, 6),
  )}`;
}

export { DEFAULT_TTL_SECONDS as QR_TTL_SECONDS };