import type { ObjectId } from "./object-types.js";

export interface ManagedPointGeometry {
  type: "Point";
  /** GeoJSON order: [lng, lat]. */
  coordinates: [number, number];
}

export interface ManagedLineStringGeometry {
  type: "LineString";
  /** GeoJSON order: [lng, lat][]. */
  coordinates: Array<[number, number]>;
}

export interface ManagedPolygonGeometry {
  type: "Polygon";
  /** GeoJSON rings: outer + holes, each [lng, lat][]. */
  coordinates: Array<Array<[number, number]>>;
}

export type ManagedGeometry =
  | ManagedPointGeometry
  | ManagedLineStringGeometry
  | ManagedPolygonGeometry;

export interface NormalizedPoint {
  kind: "Point";
  lat: number;
  lng: number;
  bbox: readonly [number, number, number, number];
}

export interface NormalizedLineString {
  kind: "LineString";
  /** Packed lat/lng pairs. */
  coords: Float64Array;
  pointCount: number;
  lengthMetersApprox: number;
  /** Cumulative distance along line (meters), length = pointCount. */
  distances: Float64Array;
  bbox: readonly [number, number, number, number];
}

export interface NormalizedPolygon {
  kind: "Polygon";
  rings: Float64Array[];
  ringCounts: number[];
  bbox: readonly [number, number, number, number];
}

export type NormalizedGeometry = NormalizedPoint | NormalizedLineString | NormalizedPolygon;

/** Reject LineString/Polygon larger than this (availability). `0` = unlimited. */
export const DEFAULT_MAX_VERTICES_PER_GEOMETRY = 65_536;

export interface NormalizeGeometryOptions {
  maxVertices?: number;
}

export interface GeometryInputObject {
  id?: ObjectId;
  coordinates?: unknown;
  geometry?: unknown;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Reject removed tuple syntax before callers mutate a store or index. */
export function assertManagedCoordinateFormat(input: GeometryInputObject): void {
  if (Array.isArray(input.coordinates)) {
    throw new TypeError("ObjectManager: use coordinates: { lat, lng } or geometry: { type: 'Point', coordinates: [lng, lat] }.");
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const a = Number(value[0]);
  const b = Number(value[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function bboxFromLatLng(lat: number, lng: number): readonly [number, number, number, number] {
  return [lat, lng, lat, lng];
}

function expandBBox(
  bbox: readonly [number, number, number, number] | null,
  lat: number,
  lng: number
): readonly [number, number, number, number] {
  if (!bbox) return [lat, lng, lat, lng];
  return [
    Math.min(bbox[0], lat),
    Math.min(bbox[1], lng),
    Math.max(bbox[2], lat),
    Math.max(bbox[3], lng)
  ];
}

/** Approx haversine meters — good enough for dash/gradient progress. */
export function approxHaversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Normalize ManagedObject geometry.
 * Named `{ coordinates: {lat, lng} }` becomes a Point.
 * Also accepts GeoJSON `geometry.coordinates` for Point ([lng, lat]).
 */
export function normalizeManagedGeometry(
  input: GeometryInputObject,
  options: NormalizeGeometryOptions = {}
): NormalizedGeometry {
  assertManagedCoordinateFormat(input);
  const maxVertices = Number.isFinite(Number(options.maxVertices))
    ? Math.max(0, Math.floor(Number(options.maxVertices)))
    : DEFAULT_MAX_VERTICES_PER_GEOMETRY;
  const geometry = input.geometry as { type?: string; coordinates?: unknown } | undefined;

  if (geometry && typeof geometry.type === "string") {
    if (geometry.type === "Point") {
      const pair = asPair(geometry.coordinates);
      if (!pair) throw new TypeError("ObjectManager: Point geometry requires [lng, lat]");
      const [lng, lat] = pair;
      return { kind: "Point", lat, lng, bbox: bboxFromLatLng(lat, lng) };
    }
    if (geometry.type === "LineString") {
      return normalizeLineString(geometry.coordinates, maxVertices);
    }
    if (geometry.type === "Polygon") {
      return normalizePolygon(geometry.coordinates, maxVertices);
    }
    throw new TypeError(`ObjectManager: unsupported geometry type "${geometry.type}"`);
  }

  // Named point coordinates cannot be confused with GeoJSON positions.
  const legacy = input.coordinates;
  if (legacy == null) throw new TypeError("ObjectManager: object requires geometry or coordinates");
  if (typeof legacy === "object") {
    const lat = Number((legacy as { lat?: unknown }).lat);
    const lng = Number((legacy as { lng?: unknown }).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new TypeError("ObjectManager: coordinates must be finite { lat, lng }");
    }
    return { kind: "Point", lat, lng, bbox: bboxFromLatLng(lat, lng) };
  }
  throw new TypeError("ObjectManager: invalid coordinates");
}

function assertVertexBudget(count: number, maxVertices: number): void {
  if (maxVertices > 0 && count > maxVertices) {
    throw new RangeError(
      `ObjectManager: geometry exceeds maxVertices (${maxVertices})`
    );
  }
}

function normalizeLineString(raw: unknown, maxVertices: number): NormalizedLineString {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new TypeError("ObjectManager: LineString requires at least 2 positions");
  }
  assertVertexBudget(raw.length, maxVertices);
  const coords = new Float64Array(raw.length * 2);
  const distances = new Float64Array(raw.length);
  let bbox: readonly [number, number, number, number] | null = null;
  let length = 0;
  let prevLat = 0;
  let prevLng = 0;
  for (let i = 0; i < raw.length; i++) {
    const pair = asPair(raw[i]);
    if (!pair) throw new TypeError("ObjectManager: LineString position must be [lng, lat]");
    const [lng, lat] = pair;
    coords[i * 2] = lat;
    coords[i * 2 + 1] = lng;
    bbox = expandBBox(bbox, lat, lng);
    if (i > 0) length += approxHaversineMeters(prevLat, prevLng, lat, lng);
    distances[i] = length;
    prevLat = lat;
    prevLng = lng;
  }
  return {
    kind: "LineString",
    coords,
    pointCount: raw.length,
    lengthMetersApprox: length,
    distances,
    bbox: bbox!
  };
}

function normalizePolygon(raw: unknown, maxVertices: number): NormalizedPolygon {
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new TypeError("ObjectManager: Polygon requires at least one ring");
  }
  let total = 0;
  for (const ring of raw) {
    if (!Array.isArray(ring) || ring.length < 3) {
      throw new TypeError("ObjectManager: Polygon ring requires at least 3 positions");
    }
    total += ring.length;
  }
  assertVertexBudget(total, maxVertices);
  const rings: Float64Array[] = [];
  const ringCounts: number[] = [];
  let bbox: readonly [number, number, number, number] | null = null;
  for (const ring of raw) {
    if (!Array.isArray(ring) || ring.length < 3) {
      throw new TypeError("ObjectManager: Polygon ring requires at least 3 positions");
    }
    const packed = new Float64Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      const pair = asPair(ring[i]);
      if (!pair) throw new TypeError("ObjectManager: Polygon position must be [lng, lat]");
      const [lng, lat] = pair;
      packed[i * 2] = lat;
      packed[i * 2 + 1] = lng;
      bbox = expandBBox(bbox, lat, lng);
    }
    rings.push(packed);
    ringCounts.push(ring.length);
  }
  return { kind: "Polygon", rings, ringCounts, bbox: bbox! };
}

export function pointInRing(lat: number, lng: number, ring: Float64Array): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i * 2];
    const xi = ring[i * 2 + 1];
    const yj = ring[j * 2];
    const xj = ring[j * 2 + 1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Cheap point read for mass ingest — no NormalizedPoint / bbox allocation.
 * Returns null for non-points and invalid coordinates.
 */
export function readManagedPoint(input: GeometryInputObject): { lat: number; lng: number } | null {
  assertManagedCoordinateFormat(input);
  const geometry = input.geometry as { type?: string; coordinates?: unknown } | undefined;
  if (geometry && typeof geometry.type === "string") {
    if (geometry.type !== "Point") return null;
    const pair = asPair(geometry.coordinates);
    if (!pair) return null;
    return { lat: pair[1], lng: pair[0] };
  }
  const legacy = input.coordinates;
  if (legacy == null) return null;
  if (typeof legacy === "object") {
    const lat = Number((legacy as { lat?: unknown }).lat);
    const lng = Number((legacy as { lng?: unknown }).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }
  return null;
}

/**
 * Soft normalize for ingest: returns null for invalid legacy points (kept in store, not indexed).
 * Strict GeoJSON geometries still throw on structural errors.
 */
export function tryNormalizeManagedGeometry(
  input: GeometryInputObject,
  options: NormalizeGeometryOptions = {}
): NormalizedGeometry | null {
  assertManagedCoordinateFormat(input);
  const geometry = input.geometry as { type?: string; coordinates?: unknown } | undefined;
  if (geometry && typeof geometry.type === "string") {
    return normalizeManagedGeometry(input, options);
  }
  const legacy = input.coordinates;
  if (legacy == null) return null;
  if (typeof legacy === "object") {
    const lat = Number((legacy as { lat?: unknown }).lat);
    const lng = Number((legacy as { lng?: unknown }).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { kind: "Point", lat, lng, bbox: bboxFromLatLng(lat, lng) };
  }
  return null;
}
