import { haversineMeters } from './geo.js';
import type { CoreContext } from '@studiodesk/core';
import { getStudio } from '@studiodesk/core';

/**
 * Mobile check-in.
 *
 * The member's phone reports its GPS position; we only accept the check-in if
 * they are physically at the studio. Accuracy is self-reported by the OS, so
 * the radius is generous and a spoofed-but-wrong location still fails.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

export interface GeofenceCheck {
  inside: boolean;
  distanceMeters: number;
  allowedMeters: number;
  accuracyPenaltyMeters: number;
  reason?: 'no-geofence' | 'no-location' | 'too-far' | 'low-accuracy';
}

export const DEFAULT_RADIUS_METERS = 150;
export const MIN_ACCURACY_METERS = 100;

export async function checkGeofence(
  ctx: CoreContext,
  point?: GeoPoint,
  options: { radiusMeters?: number } = {},
): Promise<GeofenceCheck> {
  const studio = await getStudio(ctx);
  const fence = studio.checkinGeofence;

  if (!fence) {
    return {
      inside: true,
      distanceMeters: 0,
      allowedMeters: 0,
      accuracyPenaltyMeters: 0,
      reason: 'no-geofence',
    };
  }
  if (!point) {
    return {
      inside: false,
      distanceMeters: Number.POSITIVE_INFINITY,
      allowedMeters: fence.radiusMeters,
      accuracyPenaltyMeters: 0,
      reason: 'no-location',
    };
  }

  const accuracy = point.accuracyMeters ?? 0;
  // A fuzzy GPS reading deserves a bigger leash; a precise one does not.
  const penalty = accuracy > MIN_ACCURACY_METERS ? Math.min(accuracy - MIN_ACCURACY_METERS, 100) : 0;
  const allowed = (options.radiusMeters ?? fence.radiusMeters) + penalty;
  const distance = haversineMeters(point, fence);

  return {
    inside: distance <= allowed,
    distanceMeters: Math.round(distance),
    allowedMeters: Math.round(allowed),
    accuracyPenaltyMeters: Math.round(penalty),
    reason: distance <= allowed ? undefined : 'too-far',
  };
}

/** Human-readable explanation, used by the app's "why was I rejected?" copy. */
export function explainGeofence(check: GeofenceCheck): string {
  switch (check.reason) {
    case 'no-geofence':
      return 'This studio has not set a check-in location yet.';
    case 'no-location':
      return 'We could not read your location. Turn on location services and try again.';
    case 'too-far':
      return `You are ${formatDistance(check.distanceMeters)}m from the studio (limit ${check.allowedMeters}m).`;
    default:
      return check.inside ? 'You are at the studio.' : 'Location check failed.';
  }
}

function formatDistance(meters: number): string {
  return meters < 1000 ? String(Math.round(meters)) : `${(meters / 1000).toFixed(1)}km`;
}

/**
 * Records a location-based check-in. Returns the geofence verdict alongside the
 * attendance record so the caller can decide whether to enforce it.
 */
export async function geoCheckin(
  ctx: CoreContext,
  input: {
    memberId: string;
    classId?: string;
    bookingId?: string;
    point: GeoPoint;
    /** Staff can override the fence (e.g. outdoor pop-up class). */
    override?: boolean;
    enforceGeofence?: boolean;
  },
): Promise<{
  accepted: boolean;
  reason?: string;
  attendanceId?: string;
  distanceMeters?: number;
  duplicate: boolean;
}> {
  const { recordAttendance } = await import('@studiodesk/core');
  const check = await checkGeofence(ctx, input.point);

  const enforce = input.enforceGeofence !== false && check.reason !== 'no-geofence';
  if (enforce && !check.inside && !input.override) {
    return {
      accepted: false,
      reason: explainGeofence(check),
      distanceMeters: check.distanceMeters,
      duplicate: false,
    };
  }

  const result = await recordAttendance(ctx, {
    memberId: input.memberId,
    classId: input.classId,
    bookingId: input.bookingId,
    method: 'geo',
    latitude: input.point.latitude,
    longitude: input.point.longitude,
    distanceMeters: check.distanceMeters,
  });

  return {
    accepted: true,
    attendanceId: result.attendance.id,
    distanceMeters: check.distanceMeters,
    duplicate: result.duplicate,
  };
}