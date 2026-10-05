/**
 * Stable, typed application errors. Every package throws these.
 *
 * Security note: `message` is safe to return to a client, but `details` is
 * not always safe. `toErrorBody()` below is the single place that decides what
 * leaves the server - it strips details for 5xx responses so internal failures
 * (stack traces, SQL, upstream payloads) never reach a browser. Handlers that
 * deliberately expose details (validation) always use 4xx codes.
 */

export type ErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'forbidden'
  | 'unauthorized'
  | 'payment_failed'
  | 'limit_reached'
  | 'class_full'
  | 'not_booked'
  | 'already_cancelled'
  | 'outside_geofence'
  | 'duplicate_checkin'
  | 'gateway_error'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  forbidden: 403,
  unauthorized: 401,
  payment_failed: 402,
  limit_reached: 402,
  class_full: 409,
  not_booked: 409,
  already_cancelled: 409,
  outside_geofence: 422,
  duplicate_checkin: 409,
  gateway_error: 502,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
  }

  toJSON() {
    return { error: this.code, message: this.message, details: this.details };
  }
}

export const notFound = (what: string, id?: string) =>
  new AppError('not_found', id ? `${what} ${id} not found` : `${what} not found`, { what, id });

export const validationFailed = (message: string, details?: unknown) =>
  new AppError('validation_failed', message, details);

export const conflict = (message: string, details?: unknown) =>
  new AppError('conflict', message, details);

export const forbidden = (message = 'Not allowed on this plan') =>
  new AppError('forbidden', message);

export const unauthorized = (message = 'Sign in required') =>
  new AppError('unauthorized', message);

export const limitReached = (message: string, details?: unknown) =>
  new AppError('limit_reached', message, details);

export const gatewayError = (message: string, details?: unknown) =>
  new AppError('gateway_error', message, details);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Messages returned for unexpected server-side failures. */
export const GENERIC_500_MESSAGE = 'Something went wrong on our side.';

/**
 * Normalise anything thrown into a JSON-serialisable error body.
 *
 * 4xx: the message and details are the user's problem, so they are returned
 * verbatim. 5xx: an unexpected bug, so only a generic message leaves the server
 * and the real error is logged by the caller.
 */
export function toErrorBody(err: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (isAppError(err)) {
    if (err.statusCode >= 500) {
      return {
        statusCode: err.statusCode,
        body: { error: err.code, message: GENERIC_500_MESSAGE },
      };
    }
    return { statusCode: err.statusCode, body: err.toJSON() };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    statusCode: 500,
    body: { error: 'internal_error', message: GENERIC_500_MESSAGE },
  };
}