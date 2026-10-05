import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * API client for the mobile app.
 *
 * The mobile app talks to the StudioDesk HTTP API, not the core packages
 * directly - that keeps the binary small and means the same rules are enforced
 * on the server. Point `EXPO_PUBLIC_API_URL` at your deployment.
 */

const DEFAULT_URL = 'http://localhost:4000';

export const API_URL =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? DEFAULT_URL;

const TOKEN_KEY = 'studiodesk.token';
const MEMBER_KEY = 'studiodesk.memberId';

let token: string | null = null;
let memberId: string | null = null;

export async function hydrate(): Promise<void> {
  const [savedToken, savedMember] = await Promise.all([
    AsyncStorage.getItem(TOKEN_KEY),
    AsyncStorage.getItem(MEMBER_KEY),
  ]);
  token = savedToken;
  memberId = savedMember;
}

export async function signIn(nextToken: string, nextMemberId: string): Promise<void> {
  token = nextToken;
  memberId = nextMemberId;
  await AsyncStorage.multiSet([
    [TOKEN_KEY, nextToken],
    [MEMBER_KEY, nextMemberId],
  ]);
}

export async function signOut(): Promise<void> {
  token = null;
  memberId = null;
  await AsyncStorage.multiRemove([TOKEN_KEY, MEMBER_KEY]);
}

export function currentMemberId(): string | null {
  return memberId;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString(), {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const body = payload as { error?: string; message?: string };
    throw new ApiError(
      body.message ?? `Request failed (${response.status})`,
      response.status,
      body.error,
    );
  }
  return payload as T;
}

/* -------------------------------------------------------------------------- */
/* Typed endpoints                                                            */
/* -------------------------------------------------------------------------- */

export interface ClassSummary {
  id: string;
  name: string;
  instructorId: string;
  startTime: string;
  endTime?: string;
  capacity: number;
  booked: number;
  waitlisted: number;
  attended: number;
  spotsLeft: number;
  isFull: boolean;
  isPast: boolean;
  instructorName?: string;
  room?: string;
  creditCost?: number;
}

export interface MyBooking {
  id: string;
  memberId: string;
  classId: string;
  status: 'booked' | 'waitlisted' | 'attended' | 'no-show' | 'cancelled';
  waitlistPosition?: number;
  className?: string;
  startTime?: string;
  creditsCharged?: number;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  readAt?: string;
  createdAt?: string;
  data?: Record<string, string | number>;
}

export interface PackInfo {
  id: string;
  name: string;
  creditsRemaining: number;
  expiresAt?: string;
  status: string;
}

export const api = {
  health: () => request<{ status: string; driver: string }>('/health'),

  /** Everything the schedule screen needs in one call. */
  schedule: (from: string, to: string) =>
    request<{ days: Array<{ date: string; isToday: boolean; entries: ClassSummary[] }> }>(
      '/api/schedule',
      { query: { from, to } },
    ),

  classes: (from: string, to: string) =>
    request<ClassSummary[]>('/api/classes', { query: { from, to } }),

  myBookings: (memberId: string) =>
    request<MyBooking[]>('/api/bookings', { query: { memberId } }),

  book: (memberId: string, classId: string, allowWaitlist = true) =>
    request<{ booking: MyBooking; waitlistPosition?: number; chargedCredits: number }>('/api/bookings', {
      method: 'POST',
      body: { memberId, classId, source: 'mobile', allowWaitlist },
    }),

  cancel: (bookingId: string, reason?: string) =>
    request<{ booking: MyBooking; late: boolean; promoted: unknown[] }>(`/api/bookings/${bookingId}`, {
      method: 'DELETE',
      body: { reason },
    }),

  checkin: (body: {
    memberId?: string;
    classId?: string;
    code?: string;
    method: 'qr' | 'geo' | 'manual';
    latitude?: number;
    longitude?: number;
  }) =>
    request<{
      ok: boolean;
      status: string;
      message: string;
      memberName?: string;
      distanceMeters?: number;
    }>('/api/checkin', { method: 'POST', body }),

  notifications: (memberId: string) =>
    request<Notification[]>('/api/notifications', { query: { memberId } }),

  markNotificationRead: (id: string) =>
    request<Notification>(`/api/notifications/${id}/read`, { method: 'POST' }),

  buyPack: (memberId: string, packName: string, idempotencyKey?: string) =>
    request<{ pack: PackInfo; charged: boolean; amountCents: number }>('/api/billing/packs', {
      method: 'POST',
      body: { memberId, packName, idempotencyKey },
    }),

  buyDropIn: (memberId: string, classId: string, idempotencyKey?: string) =>
    request<{ charged: boolean; waitlisted: boolean; bookingId?: string; amountCents: number }>(
      '/api/billing/drop-ins',
      { method: 'POST', body: { memberId, classId, idempotencyKey } },
    ),

  myAttendance: (memberId: string) =>
    request<Array<{ className: string; startTime: string; method: string }>>(
      `/api/members/${memberId}`,
    )
      .then((detail) => detail.history.slice(0, 30))
      .catch(() => []),
};
