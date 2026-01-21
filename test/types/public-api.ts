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
  bounds: [[55.7, 37.5], [55.8, 37.7]],
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
