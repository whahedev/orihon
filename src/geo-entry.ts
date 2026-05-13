import { destination, type LatLngLike } from "./geo.js";
import type { GeoJSONFeature, GeoJSONPolygonGeometry, GeoJSONPosition } from "./geojson-types.js";

export {
  LatLng,
  LatLngBounds,
  latLng,
  lngLat,
  fromGeoJSONPosition,
  latLngs,
  lngLats,
  fromGeoJSONPositions,
  toGeoJSONPosition,
  bounds,
  distance,
  destination,
  geodesicInterpolate,
  wrapLng,
  EARTH_RADIUS
} from "./geo.js";

export type { LatLngLike, LatLngBoundsLike } from "./geo.js";

export interface BufferPointOptions {
  steps?: number;
  properties?: Record<string, unknown> | null;
}

/**
 * A plain GeoJSON polygon feature, typed with the shared GeoJSON types so the result can be
 * handed straight to `geoJSON()` or a `FeatureSource` without a cast.
 */
export interface BufferPointFeature extends GeoJSONFeature {
  properties: Record<string, unknown> | null;
  geometry: GeoJSONPolygonGeometry;
}

/** Create a geodesic GeoJSON polygon around a point. Radius is in meters. */
export function bufferPoint(center: LatLngLike, radiusMeters: number, options: BufferPointOptions = {}): BufferPointFeature {
  const radius = Number(radiusMeters);
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError("bufferPoint radius must be a non-negative number");
  const requestedSteps = Number(options.steps ?? 64);
  if (!Number.isFinite(requestedSteps)) throw new RangeError("bufferPoint steps must be a finite number");
  const steps = Math.max(8, Math.min(256, Math.round(requestedSteps)));
  const ring = Array.from({ length: steps }, (_, index): GeoJSONPosition => {
    const point = destination(center, radius, index * 360 / steps);
    return [point.lng, point.lat];
  });
  ring.push([...ring[0]]);
  return {
    type: "Feature",
    properties: options.properties ? { ...options.properties } : null,
    geometry: { type: "Polygon", coordinates: [ring] }
  };
}
