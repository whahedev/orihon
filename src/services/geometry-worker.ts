import { latLng, type LatLngLike } from "../geo.js";
import {
  buildClusterIndex,
  buildClusterLayout,
  buildGreedyClusterLayout,
  clusterLayoutWorkerSource,
  decodeClusterIndex,
  type ClusterIndex,
  type ClusterLayoutRequest,
  type ClusterLayoutResult
} from "./cluster-layout.js";
import {
  isAsyncIterable,
  resolveAsyncBatchOptions,
  throwIfAsyncAborted,
  yieldAsyncBatch,
  type AsyncBatchOptions
} from "./async-batch.js";

export type GeometryPointInput = LatLngLike | { coordinates?: LatLngLike; latlng?: LatLngLike; lat?: number; lng?: number };

export interface PreparedPointBatch {
  points: Float32Array;
  count: number;
  skipped: number;
}

export interface GeometryWorkerOptions {
  useWorker?: boolean;
}

export interface GeometryPrepareOptions extends AsyncBatchOptions {}

let requestId = 0;

type PendingResolve =
  | { type: "preparePoints"; resolve: (value: PreparedPointBatch) => void }
  | { type: "clusterLayout"; resolve: (value: ClusterLayoutResult) => void }
  | { type: "greedyClusterLayout"; resolve: (value: ClusterLayoutResult) => void }
  | { type: "clusterIndex"; resolve: (value: ClusterIndex) => void };

export class GeometryWorkerPool {
  readonly useWorker: boolean;
  worker: Worker | null = null;
  workerUrl: string | null = null;
  readonly pending = new Map<number, PendingResolve>();

  constructor(options: GeometryWorkerOptions = {}) {
    this.useWorker = options.useWorker !== false && typeof Worker !== "undefined" && typeof URL !== "undefined";
  }

  async preparePoints(
    points: Iterable<GeometryPointInput> | AsyncIterable<GeometryPointInput>,
    options: GeometryPrepareOptions = {}
  ): Promise<PreparedPointBatch> {
    if (!this.useWorker) return preparePointBatchAsync(points, options);
    const serialized = await collectPointInput(points, options);
    const worker = this.#worker();
    if (!worker) return preparePointBatchAsync(serialized, options);
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

  /** Build one zoom in a worker without cloning arbitrary ids or a full hierarchy. */
  async greedyClusterLayout(request: ClusterLayoutRequest): Promise<ClusterLayoutResult> {
    if (!this.useWorker) return buildGreedyClusterLayout(request);
    const worker = this.#worker();
    if (!worker) return buildGreedyClusterLayout(request);
    const id = ++requestId;
    const coordsCopy = request.coords.slice();
    return new Promise<ClusterLayoutResult>((resolve) => {
      this.pending.set(id, {
        type: "greedyClusterLayout",
        resolve: (result) => {
          for (const single of result.singles) {
            single.id = request.ids[Number(single.id)];
          }
          for (const cluster of result.clusters) {
            for (let i = 0; i < cluster.ids.length; i++) {
              cluster.ids[i] = request.ids[Number(cluster.ids[i])];
            }
          }
          resolve(result);
        }
      });
      worker.postMessage(
        {
          id,
          type: "greedyClusterLayout",
          coords: coordsCopy,
          zoomBucket: request.zoomBucket,
          gridSize: request.gridSize,
          minPoints: request.minPoints,
          clusterize: request.clusterize,
          clusterMaxZoom: request.clusterMaxZoom,
          clusterMinZoom: request.clusterMinZoom,
          simple: request.simple
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
        if (pending.type === "greedyClusterLayout" && data.type === "greedyClusterLayout") {
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

/** Cooperative main-thread fallback for environments where Worker is unavailable or disabled. */
export async function preparePointBatchAsync(
  points: Iterable<GeometryPointInput> | AsyncIterable<GeometryPointInput>,
  options: GeometryPrepareOptions = {}
): Promise<PreparedPointBatch> {
  const resolved = resolveAsyncBatchOptions(options, 50_000);
  const total = Array.isArray(points) ? points.length : null;
  const values: number[] = [];
  let processed = 0;
  let skipped = 0;
  throwIfAsyncAborted(resolved.signal);

  const consume = (point: GeometryPointInput): void => {
    const value = normalizePoint(point);
    if (value) values.push(value[0], value[1]);
    else skipped++;
    processed++;
  };
  const boundary = async (): Promise<void> => {
    resolved.onProgress?.(processed, total);
    throwIfAsyncAborted(resolved.signal);
    await yieldAsyncBatch(resolved.yieldMode);
    throwIfAsyncAborted(resolved.signal);
  };

  if (isAsyncIterable<GeometryPointInput>(points)) {
    for await (const point of points) {
      consume(point);
      if (processed % resolved.chunkSize === 0) await boundary();
    }
  } else if (Array.isArray(points)) {
    for (let index = 0; index < points.length; index++) {
      consume(points[index]);
      if (processed % resolved.chunkSize === 0 && processed < points.length) await boundary();
    }
  } else {
    for (const point of points) {
      consume(point);
      if (processed % resolved.chunkSize === 0) await boundary();
    }
  }

  throwIfAsyncAborted(resolved.signal);
  resolved.onProgress?.(processed, total);
  return { points: new Float32Array(values), count: values.length / 2, skipped };
}

async function collectPointInput(
  points: Iterable<GeometryPointInput> | AsyncIterable<GeometryPointInput>,
  options: GeometryPrepareOptions
): Promise<GeometryPointInput[]> {
  const resolved = resolveAsyncBatchOptions(options, 50_000);
  const total = Array.isArray(points) ? points.length : null;
  const serialized: GeometryPointInput[] = [];
  let processed = 0;
  throwIfAsyncAborted(resolved.signal);
  const consume = (point: GeometryPointInput): void => {
    serialized.push(serializePoint(point));
    processed++;
  };
  const boundary = async (): Promise<void> => {
    resolved.onProgress?.(processed, total);
    throwIfAsyncAborted(resolved.signal);
    await yieldAsyncBatch(resolved.yieldMode);
    throwIfAsyncAborted(resolved.signal);
  };

  if (isAsyncIterable<GeometryPointInput>(points)) {
    for await (const point of points) {
      consume(point);
      if (processed % resolved.chunkSize === 0) await boundary();
    }
  } else if (Array.isArray(points)) {
    for (let index = 0; index < points.length; index++) {
      consume(points[index]);
      if (processed % resolved.chunkSize === 0 && processed < points.length) await boundary();
    }
  } else {
    for (const point of points) {
      consume(point);
      if (processed % resolved.chunkSize === 0) await boundary();
    }
  }

  throwIfAsyncAborted(resolved.signal);
  resolved.onProgress?.(processed, total);
  return serialized;
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
