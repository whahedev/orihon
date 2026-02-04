import {
  GeometryWorkerError,
  createGeometryWorkerPool,
  type PrefetchTileLayerOptions
} from "../../src/index.js";

const ownedPool = createGeometryWorkerPool({ useWorker: false });
ownedPool.destroy();

const workerError: Error = new GeometryWorkerError("worker failed", { cause: new Error("root cause") });
void workerError;

const boundsPrefetch: PrefetchTileLayerOptions = {
  bounds: [{ lat: 55.7, lng: 37.5 }, { lat: 55.8, lng: 37.7 }],
  zooms: [10, 11]
};

const explicitRangePrefetch: PrefetchTileLayerOptions = {
  xRange: [600, 610],
  yRange: [300, 310],
  zooms: [10]
};

// @ts-expect-error Explicit prefetch ranges require both axes when bounds are absent.
const missingYRange: PrefetchTileLayerOptions = {
  xRange: [600, 610],
  zooms: [10]
};

void boundsPrefetch;
void explicitRangePrefetch;
void missingYRange;

// @ts-expect-error The library-managed shared worker is not part of the package API.
import { getSharedGeometryWorkerPool } from "../../src/index.js";
void getSharedGeometryWorkerPool;

import { marker, createMap, fromGeoJSONPosition, toGeoJSONPosition, type LatLngLike, type ManagedGeometry } from "../../src/index.js";
const geoJSONPosition: [number, number] = [37.618423, 55.751244];
marker(fromGeoJSONPosition(geoJSONPosition));
const namedPosition: LatLngLike = { lat: 55.751244, lng: 37.618423 };
const roundTrip: [longitude: number, latitude: number] = toGeoJSONPosition(namedPosition);
void roundTrip;
// @ts-expect-error GeoJSON tuples must pass through the explicit converter.
marker(geoJSONPosition);
// @ts-expect-error Bare latitude-first tuples are no longer accepted either.
createMap("map", { center: [55.751244, 37.618423] });
const managedPoint: ManagedGeometry = { type: "Point", coordinates: geoJSONPosition };
// @ts-expect-error ObjectManager GeoJSON cannot silently become a latitude-first marker.
marker(managedPoint.coordinates);
