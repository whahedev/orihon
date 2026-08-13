import {
  LatLng,
  Point,
  latLng,
  point,
  project,
  scale,
  unproject,
  type LatLngLike,
  type PointLike
} from "./geo.js";

export interface CoordinateReferenceSystem {
  readonly code: "EPSG:3857" | "Simple";
  project(latlng: LatLngLike, zoom: number): Point;
  unproject(point: PointLike, zoom: number): LatLng;
  scale(zoom: number): number;
  readonly wrapLng: boolean;
  readonly wrapLat: boolean;
}

const EPSG3857: CoordinateReferenceSystem = Object.freeze({
  code: "EPSG:3857" as const,
  project,
  unproject,
  scale,
  wrapLng: true,
  wrapLat: false
});

const Simple: CoordinateReferenceSystem = Object.freeze({
  code: "Simple" as const,
  project(value: LatLngLike, zoom: number): Point {
    const coordinate = latLng(value);
    const factor = 2 ** zoom;
    return new Point(coordinate.lng * factor, -coordinate.lat * factor);
  },
  unproject(value: PointLike, zoom: number): LatLng {
    const projected = point(value);
    const factor = 2 ** zoom;
    return new LatLng(-projected.y / factor, projected.x / factor);
  },
  scale(zoom: number): number {
    return 2 ** zoom;
  },
  wrapLng: false,
  wrapLat: false
});

export const CRS = Object.freeze({ EPSG3857, Simple });
export type CRSInput = CoordinateReferenceSystem | "EPSG:3857" | "Simple";

export function resolveCRS(input: CRSInput | undefined): CoordinateReferenceSystem {
  if (!input || input === "EPSG:3857") return EPSG3857;
  if (input === "Simple") return Simple;
  if (input.code === "EPSG:3857" || input.code === "Simple") return input;
  throw new TypeError(`Unsupported CRS: ${String((input as { code?: unknown }).code)}`);
}

export class CRSCompatibilityError extends Error {
  constructor(message = "WebGL layers require EPSG:3857") {
    super(message);
    this.name = "CRSCompatibilityError";
  }
}

export function assertMercator(crs: CoordinateReferenceSystem | undefined): void {
  if (crs && crs.code !== "EPSG:3857") throw new CRSCompatibilityError();
}
