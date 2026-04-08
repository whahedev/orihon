const MAX_LAT = 85.0511287798066;
const EARTH_RADIUS = 6378137;
const TILE_SIZE = 256;

export type PointLike = Point | [number, number] | { x: number; y: number };
/** Named geographic or CRS coordinates; bare tuples are deliberately not accepted. */
export type LatLngLike = LatLng | { lat: number; lng: number };
export type LatLngBoundsLike =
  | LatLngBounds
  | [LatLngLike, LatLngLike]
  | { south: number; west: number; north: number; east: number };

export class Point {
  constructor(public x: number, public y: number) {
    this.x = Number(x);
    this.y = Number(y);
  }

  clone(): Point {
    return new Point(this.x, this.y);
  }

  add(value: PointLike): Point {
    const other = point(value);
    return new Point(this.x + other.x, this.y + other.y);
  }

  subtract(value: PointLike): Point {
    const other = point(value);
    return new Point(this.x - other.x, this.y - other.y);
  }

  multiplyBy(value: number): Point {
    return new Point(this.x * value, this.y * value);
  }

  divideBy(value: number): Point {
    return new Point(this.x / value, this.y / value);
  }

  round(): Point {
    return new Point(Math.round(this.x), Math.round(this.y));
  }

  floor(): Point {
    return new Point(Math.floor(this.x), Math.floor(this.y));
  }

  ceil(): Point {
    return new Point(Math.ceil(this.x), Math.ceil(this.y));
  }

  distanceTo(value: PointLike): number {
    const other = point(value);
    return Math.hypot(other.x - this.x, other.y - this.y);
  }

  equals(value: PointLike): boolean {
    const other = point(value);
    return other.x === this.x && other.y === this.y;
  }

  toArray(): [number, number] {
    return [this.x, this.y];
  }
}

export function point(value: PointLike): Point;
export function point(x: number, y: number): Point;
export function point(value: PointLike | number, y?: number): Point {
  if (value instanceof Point) return value;
  if (Array.isArray(value)) return new Point(value[0], value[1]);
  if (typeof value === "object") return new Point(value.x, value.y);
  return new Point(value, Number(y));
}

export class Bounds {
  min: Point;
  max: Point;

  constructor(a?: PointLike | PointLike[], b?: PointLike) {
    this.min = new Point(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    this.max = new Point(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    if (Array.isArray(a) && a.length > 0 && typeof a[0] !== "number") {
      for (const value of a as PointLike[]) this.extend(value);
    } else if (a) {
      this.extend(a as PointLike);
    }
    if (b) this.extend(b);
  }

  extend(value: PointLike | Bounds): this {
    if (value instanceof Bounds) {
      if (value.isValid()) {
        this.extend(value.min);
        this.extend(value.max);
      }
      return this;
    }
    const next = point(value);
    this.min.x = Math.min(this.min.x, next.x);
    this.min.y = Math.min(this.min.y, next.y);
    this.max.x = Math.max(this.max.x, next.x);
    this.max.y = Math.max(this.max.y, next.y);
    return this;
  }

  getCenter(): Point {
    return this.min.add(this.max).divideBy(2);
  }

  getSize(): Point {
    return this.max.subtract(this.min);
  }

  contains(value: PointLike | Bounds): boolean {
    if (value instanceof Bounds) {
      return this.contains(value.min) && this.contains(value.max);
    }
    const next = point(value);
    return next.x >= this.min.x && next.x <= this.max.x && next.y >= this.min.y && next.y <= this.max.y;
  }

  intersects(value: Bounds): boolean {
    return value.max.x >= this.min.x && value.min.x <= this.max.x && value.max.y >= this.min.y && value.min.y <= this.max.y;
  }

  isValid(): boolean {
    return Number.isFinite(this.min.x) && Number.isFinite(this.min.y) && Number.isFinite(this.max.x) && Number.isFinite(this.max.y);
  }
}

export function pointBounds(a?: PointLike | PointLike[], b?: PointLike): Bounds {
  return new Bounds(a, b);
}

/**
 * A coordinate value. A `LatLng` handed out by `map.getCenter()`, `map.getCamera()` or a layer
 * is a value, not a handle on that object's live state, so it is immutable at runtime as well as
 * in the type surface. Derive a changed coordinate with `new LatLng(...)` or `clone()`.
 *
 * The freeze costs roughly 17ns per instance. That is real on the paths that build millions of
 * them, but those are one-time ingests (`SpatialGridIndex`, GeoJSON parsing) rather than
 * per-frame work, and it buys a whole class of aliasing bugs staying impossible.
 */
export class LatLng {
  constructor(public readonly lat: number, public readonly lng: number) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new TypeError("Coordinates require finite numeric lat and lng values.");
    }
    Object.freeze(this);
  }

  clone(): LatLng {
    return new LatLng(this.lat, this.lng);
  }

  equals(value: LatLngLike, maxMargin = 1e-9): boolean {
    const other = latLng(value);
    return Math.max(Math.abs(this.lat - other.lat), Math.abs(this.lng - other.lng)) <= maxMargin;
  }

  distanceTo(value: LatLngLike): number {
    return distance(this, value);
  }

  wrap(): LatLng {
    return new LatLng(this.lat, wrapLng(this.lng));
  }

  toArray(): [number, number] {
    return [this.lat, this.lng];
  }

  toString(): string {
    return `LatLng(${this.lat}, ${this.lng})`;
  }
}

export function latLng(value: LatLngLike): LatLng;
export function latLng(lat: number, lng: number): LatLng;
export function latLng(value: LatLngLike | number, lng?: number): LatLng {
  if (Array.isArray(value)) {
    throw new TypeError("Coordinate tuples are ambiguous. Use { lat, lng } or fromGeoJSONPosition([lng, lat]).");
  }
  if (value instanceof LatLng) return value;
  if (value && typeof value === "object") return new LatLng(value.lat, value.lng);
  return new LatLng(value, Number(lng));
}

/** Convert a GeoJSON longitude/latitude position (optional altitude is ignored). */
export function fromGeoJSONPosition(position: readonly [number, number, ...number[]]): LatLng {
  if (!Array.isArray(position) || position.length < 2 ||
      !Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
    throw new TypeError("fromGeoJSONPosition requires [longitude, latitude] with finite numbers.");
  }
  return new LatLng(position[1], position[0]);
}

/** Convert named coordinates to a fresh standard GeoJSON longitude/latitude pair. */
export function toGeoJSONPosition(position: LatLngLike): [longitude: number, latitude: number] {
  const value = latLng(position);
  return [value.lng, value.lat];
}

/**
 * Create a LatLng from longitude-first coordinates.
 * Useful at GeoJSON, MapLibre and other [longitude, latitude] API boundaries.
 */
export function lngLat(lng: number, lat: number): LatLng {
  return new LatLng(lat, lng);
}

export class LatLngBounds {
  south = Number.POSITIVE_INFINITY;
  west = Number.POSITIVE_INFINITY;
  north = Number.NEGATIVE_INFINITY;
  east = Number.NEGATIVE_INFINITY;

  constructor(a?: LatLngLike | LatLngLike[] | LatLngBoundsLike, b?: LatLngLike) {
    if (a instanceof LatLngBounds) {
      this.extend(a);
    } else if (Array.isArray(a)) {
      for (const value of a as LatLngLike[]) this.extend(value);
    } else if (a && "south" in a) {
      this.extend({ lat: a.south, lng: a.west });
      this.extend({ lat: a.north, lng: a.east });
    } else if (a) {
      this.extend(a as LatLngLike);
    }
    if (b) this.extend(b);
  }

  extend(value: LatLngLike | LatLngBoundsLike): this {
    if (value instanceof LatLngBounds || (value && typeof value === "object" && !Array.isArray(value) && "south" in value)) {
      const other = value instanceof LatLngBounds ? value : bounds(value);
      if (other.isValid()) {
        this.extend({ lat: other.south, lng: other.west });
        this.extend({ lat: other.north, lng: other.east });
      }
      return this;
    }
    const next = latLng(value as LatLngLike);
    this.south = Math.min(this.south, next.lat);
    this.west = Math.min(this.west, next.lng);
    this.north = Math.max(this.north, next.lat);
    this.east = Math.max(this.east, next.lng);
    return this;
  }

  getCenter(): LatLng {
    return new LatLng((this.south + this.north) / 2, (this.west + this.east) / 2);
  }

  getSouthWest(): LatLng { return new LatLng(this.south, this.west); }
  getNorthEast(): LatLng { return new LatLng(this.north, this.east); }
  getNorthWest(): LatLng { return new LatLng(this.north, this.west); }
  getSouthEast(): LatLng { return new LatLng(this.south, this.east); }

  contains(value: LatLngLike | LatLngBoundsLike): boolean {
    if (value instanceof LatLngBounds || (value && typeof value === "object" && !Array.isArray(value) && "south" in value)) {
      const other = value instanceof LatLngBounds ? value : bounds(value);
      return other.south >= this.south && other.north <= this.north && other.west >= this.west && other.east <= this.east;
    }
    const next = latLng(value as LatLngLike);
    return next.lat >= this.south && next.lat <= this.north && next.lng >= this.west && next.lng <= this.east;
  }

  intersects(value: LatLngBoundsLike): boolean {
    const other = bounds(value);
    return other.north >= this.south && other.south <= this.north && other.east >= this.west && other.west <= this.east;
  }

  pad(ratio: number): LatLngBounds {
    const latBuffer = Math.abs(this.north - this.south) * ratio;
    const lngBuffer = Math.abs(this.east - this.west) * ratio;
    return new LatLngBounds({ lat: this.south - latBuffer, lng: this.west - lngBuffer }, { lat: this.north + latBuffer, lng: this.east + lngBuffer });
  }

  equals(value: LatLngBoundsLike, maxMargin = 1e-9): boolean {
    const other = bounds(value);
    return this.getSouthWest().equals(other.getSouthWest(), maxMargin) && this.getNorthEast().equals(other.getNorthEast(), maxMargin);
  }

  isValid(): boolean {
    return Number.isFinite(this.south) && Number.isFinite(this.west) && Number.isFinite(this.north) && Number.isFinite(this.east);
  }

  toBBoxString(): string {
    return `${this.west},${this.south},${this.east},${this.north}`;
  }
}

export function bounds(
  a?: LatLngLike | LatLngLike[] | LatLngBoundsLike | null,
  b?: LatLngLike | LatLngBoundsLike
): LatLngBounds {
  if (a instanceof LatLngBounds && b === undefined) return a;
  const result = new LatLngBounds(a ?? undefined);
  if (b) result.extend(b);
  return result;
}


export function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Normalized Web Mercator in 0..1 (zoom-independent). */
export function projectMercator01(lat: number, lng: number): { x: number; y: number } {
  const sin = Math.sin((clampLat(lat) * Math.PI) / 180);
  return {
    x: (wrapLng(lng) + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}

export function scale(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

export function project(value: LatLngLike, zoom = 0): Point {
  const ll = latLng(value);
  const size = scale(zoom);
  const sin = Math.sin((clampLat(ll.lat) * Math.PI) / 180);
  return new Point(
    ((wrapLng(ll.lng) + 180) / 360) * size,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size
  );
}

export function unproject(value: PointLike, zoom = 0): LatLng {
  const source = point(value);
  const size = scale(zoom);
  const lng = (source.x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * source.y) / size;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return new LatLng(lat, wrapLng(lng));
}

export function distance(a: LatLngLike, b: LatLngLike): number {
  const p1 = latLng(a);
  const p2 = latLng(b);
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const lat1 = (p1.lat * Math.PI) / 180;
  const lat2 = (p2.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Returns a geographic destination reached from `origin` along a bearing. */
export function destination(origin: LatLngLike, distanceMeters: number, bearingDegrees: number): LatLng {
  const start = latLng(origin);
  const angularDistance = Number(distanceMeters) / EARTH_RADIUS;
  const bearing = Number(bearingDegrees) * Math.PI / 180;
  const latitude = start.lat * Math.PI / 180;
  const longitude = start.lng * Math.PI / 180;
  const targetLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
    + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const targetLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude)
  );
  return new LatLng(targetLatitude * 180 / Math.PI, wrapLng(targetLongitude * 180 / Math.PI));
}

/** Densifies a great-circle segment so no output segment exceeds the requested length. */
export function geodesicInterpolate(
  a: LatLngLike,
  b: LatLngLike,
  maxSegmentMeters = 100_000
): LatLng[] {
  const start = latLng(a);
  const end = latLng(b);
  const length = distance(start, end);
  const count = Math.max(1, Math.ceil(length / Math.max(1, Number(maxSegmentMeters))));
  if (count === 1 || length === 0) return [start.clone(), end.clone()];
  const lat1 = start.lat * Math.PI / 180;
  const lat2 = end.lat * Math.PI / 180;
  const deltaLng = (end.lng - start.lng) * Math.PI / 180;
  const bearing = Math.atan2(
    Math.sin(deltaLng) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)
  ) * 180 / Math.PI;
  const result = new Array<LatLng>(count + 1);
  for (let index = 0; index <= count; index++) {
    result[index] = index === count ? end.clone() : destination(start, length * index / count, bearing);
  }
  return result;
}

export function metersToPixels(meters: number, latitude: number, zoom: number): number {
  const latitudeScale = Math.max(1e-6, Math.cos((clampLat(Number(latitude)) * Math.PI) / 180));
  return Math.abs(Number(meters)) * scale(zoom) / (2 * Math.PI * EARTH_RADIUS * latitudeScale);
}

type ViewSize = PointLike | { width: number; height: number };

export function zoomForBounds(viewSize: ViewSize, targetBounds: LatLngBoundsLike, padding = 32, maxZoom = 18): number {
  const b = bounds(targetBounds);
  const nw = project({ lat: b.north, lng: b.west }, 0);
  const se = project({ lat: b.south, lng: b.east }, 0);
  const dx = Math.max(1e-9, Math.abs(se.x - nw.x));
  const dy = Math.max(1e-9, Math.abs(se.y - nw.y));
  const width = "width" in viewSize ? viewSize.width : point(viewSize).x;
  const height = "height" in viewSize ? viewSize.height : point(viewSize).y;
  const zx = Math.log2(Math.max(1, width - padding * 2) / dx);
  const zy = Math.log2(Math.max(1, height - padding * 2) / dy);
  return Math.max(0, Math.min(maxZoom, Math.floor(Math.min(zx, zy))));
}

export { TILE_SIZE, MAX_LAT, EARTH_RADIUS };
