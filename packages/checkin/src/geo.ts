/**
 * Geospatial helpers. Implemented directly (no turf.js) because StudioDesk
 * only ever needs a point-to-point distance.
 */

export const EARTH_RADIUS_METERS = 6_371_008.8;

export interface LatLng {
  latitude: number;
  longitude: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres between two points. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bounding-box test - cheaper than haversine for "is it obviously not here". */
export function withinBoundingBox(
  point: LatLng,
  centre: LatLng,
  radiusMeters: number,
): boolean {
  const latDelta = radiusMeters / 111_320;
  const lonDelta = radiusMeters / (111_320 * Math.max(0.1, Math.cos(toRadians(centre.latitude))));
  return (
    Math.abs(point.latitude - centre.latitude) <= latDelta &&
    Math.abs(point.longitude - centre.longitude) <= lonDelta
  );
}

/**
 * Converts an accuracy radius into a "good enough for check-in?" boolean.
 * Anything under ~65m is treated as precise, which is what modern phones
 * achieve indoors.
 */
export function isReliableAccuracy(accuracyMeters?: number): boolean {
  return accuracyMeters === undefined || accuracyMeters <= 65;
}