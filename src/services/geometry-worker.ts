import { latLng, type LatLngLike } from "../geo.js";
import {
  buildClusterIndex,
  buildClusterLayout,
  clusterLayoutWorkerSource,
  decodeClusterIndex,
  type ClusterIndex,
  type ClusterLayoutRequest,
  type ClusterLayoutResult
} from "./cluster-layout.js";

export type GeometryPointInput = LatLngLike | { coordinates?: LatLngLike; latlng?: LatLngLike; lat?: number; lng?: number };

export interface PreparedPointBatch {
  points: Float32Array;
  count: number;
  skipped: number;
}

export interface GeometryWorkerOptions {
  useWorker?: boolean;
}

let requestId = 0;

type PendingResolve =
  | { type: "preparePoints"; resolve: (value: PreparedPointBatch) => void }
  | { type: "clusterLayout"; resolve: (value: ClusterLayoutResult) => void }
  | { type: "clusterIndex"; resolve: (value: ClusterIndex) => void };

export class GeometryWorkerPool {
  readonly useWorker: boolean;
  worker: Worker | null = null;
  workerUrl: string | null = null;
  readonly pending = new Map<number, PendingResolve>();

  constructor(options: GeometryWorkerOptions = {}) {
    this.useWorker = options.useWorker !== false && typeof Worker !== "undefined" && typeof URL !== "undefined";
  }

  async preparePoints(points: Iterable<GeometryPointInput>): Promise<PreparedPointBatch> {
    const serialized = Array.from(points, (item) => serializePoint(item));
    if (!this.useWorker) return preparePointBatch(serialized);
    const worker = this.#worker();
    if (!worker) return preparePointBatch(serialized);
    const id = ++requestId;
    return new Promise<PreparedPointBatch>((resolve) => {
      this.pending.set(id, { type: "preparePoints", resolve });
      worker.postMessage({ id, type: "preparePoints", points: serialized });
    });
  }

  async clusterLayout(request: ClusterLayoutRequest): Promise<ClusterLayoutResult> {
    if (!this.useWorker) return buildClusterLayout(request);
    const worker = this.#worker();
    if (!worker) return buildClusterLayout(request);
    const id = ++requestId;
    const coordsCopy = request.coords.slice();
    return new Promise<ClusterLayoutResult>((resolve) => {
      this.pending.set(id, { type: "clusterLayout", resolve });
      worker.postMessage(
        {
          id,
          type: "clusterLayout",
          ids: request.ids,
          coords: coordsCopy,
          zoomBucket: request.zoomBucket,
          gridSize: request.gridSize,
          minPoints: request.minPoints,
          clusterize: request.clusterize,
          clusterMaxZoom: request.clusterMaxZoom,
          clusterMinZoom: request.clusterMinZoom
        },
        [coordsCopy.buffer]
      );
    });
  }

  /** Build transferable hierarchical index once; zoom queries stay on the main thread. */
  async clusterIndex(request: Omit<ClusterLayoutRequest, "zoomBucket">): Promise<ClusterIndex> {
    if (!this.useWorker) return buildClusterIndex(request);
    const worker = this.#worker();
    if (!worker) return buildClusterIndex(request);
    const id = ++requestId;
    const coordsCopy = request.coords.slice();
    return new Promise<ClusterIndex>((resolve) => {
      this.pending.set(id, {
        type: "clusterIndex",
        resolve: (index: ClusterIndex) => {
          index.ids = request.ids;
          resolve(index);
        }
      });
      worker.postMessage(
        {
          id,
          type: "clusterIndex",
          coords: coordsCopy,
          gridSize: request.gridSize,
          minPoints: request.minPoints,
          clusterize: request.clusterize,
          clusterMaxZoom: request.clusterMaxZoom,
          clusterMinZoom: request.clusterMinZoom
        },
        [coordsCopy.buffer]
      );
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    for (const pending of this.pending.values()) {
      if (pending.type === "preparePoints") pending.resolve({ points: new Float32Array(), count: 0, skipped: 0 });
      else if (pending.type === "clusterIndex") {
        pending.resolve(buildClusterIndex({
          ids: [],
          coords: new Float64Array(),
          gridSize: 50,
          minPoints: 2,
          clusterize: false,
          clusterMaxZoom: 0
        }));
      } else pending.resolve({ clusters: [], singles: [] });
    }
    this.pending.clear();
  }

  #worker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
      this.workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = (event) => {
        const data = event.data || {};
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (pending.type === "preparePoints" && data.type === "preparePoints") {
          pending.resolve({ points: new Float32Array(data.points), count: data.count, skipped: data.skipped });
          return;
        }
        if (pending.type === "clusterLayout" && data.type === "clusterLayout") {
          pending.resolve({ clusters: data.clusters || [], singles: data.singles || [] });
          return;
        }
        if (pending.type === "clusterIndex" && data.type === "clusterIndex") {
          pending.resolve(decodeClusterIndex(data.index || data));
        }
      };
      return this.worker;
    } catch {
      if (this.workerUrl) {
        URL.revokeObjectURL(this.workerUrl);
        this.workerUrl = null;
      }
      return null;
    }
  }
}

let sharedGeometryWorkerPool: GeometryWorkerPool | null = null;

export function geometryWorkerPool(options?: GeometryWorkerOptions): GeometryWorkerPool {
  // Dedicated pool when workers are explicitly disabled (tests / sync-only).
  if (options && options.useWorker === false) {
    return new GeometryWorkerPool(options);
  }
  if (!sharedGeometryWorkerPool) {
    sharedGeometryWorkerPool = new GeometryWorkerPool(options);
  }
  return sharedGeometryWorkerPool;
}

export function preparePointBatch(points: Iterable<GeometryPointInput>): PreparedPointBatch {
  const values: number[] = [];
  let skipped = 0;
  for (const point of points) {
    const value = normalizePoint(point);
    if (!value) {
      skipped++;
      continue;
    }
    values.push(value[0], value[1]);
  }
  return { points: new Float32Array(values), count: values.length / 2, skipped };
}

function serializePoint(value: GeometryPointInput): GeometryPointInput {
  return value;
}

function normalizePoint(value: GeometryPointInput): [number, number] | null {
  const source = Array.isArray(value) || ("lat" in Object(value) && "lng" in Object(value))
    ? value as LatLngLike
    : (value as { coordinates?: LatLngLike; latlng?: LatLngLike }).coordinates ?? (value as { latlng?: LatLngLike }).latlng;
  if (!source) return null;
  const point = latLng(source);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return [point.lat, point.lng];
}

const WORKER_SOURCE = clusterLayoutWorkerSource();
