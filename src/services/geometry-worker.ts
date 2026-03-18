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
  clusterIndexWasmWorkerAddonSource,
  decodeClusterIndexWasmBlob
} from "./cluster-index-wasm.js";
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

export interface ClusterWasmWorkerStats {
  attempts: number;
  successes: number;
  fallbacks: number;
  recycledWorkers: number;
  datasetInstalls: number;
  datasetReuses: number;
  datasetMisses: number;
  datasetBytesTransferred: number;
  avoidedCoordTransferBytes: number;
  lastDatasetBytes: number;
  lastWasmMemoryBytes: number;
  lastOutputBytes: number;
  lastScratchBytes: number;
}

export interface GeometryPrepareOptions extends AsyncBatchOptions {}

let requestId = 0;

type ClusterDatasetTagged = { __datasetVersion?: number };
type ClusterGreedyWorkerRequest = ClusterLayoutRequest & ClusterDatasetTagged;
type ClusterIndexWorkerRequest = Omit<ClusterLayoutRequest, "zoomBucket"> & ClusterDatasetTagged;

type PendingResolve = (
  | { type: "preparePoints"; resolve: (value: PreparedPointBatch) => void }
  | { type: "clusterLayout"; resolve: (value: ClusterLayoutResult) => void }
  | { type: "clusterDatasetInstall"; datasetId: number; resolve: (ok: boolean) => void }
  | { type: "greedyClusterLayout"; request: ClusterGreedyWorkerRequest; resolve: (value: ClusterLayoutResult) => void }
  | {
      type: "clusterIndex";
      request: ClusterIndexWorkerRequest;
      resolve: (value: ClusterIndex) => void;
    }
) & { reject: (reason?: unknown) => void };

function geometryWorkerAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Geometry worker pool was destroyed", "AbortError");
  }
  const error = new Error("Geometry worker pool was destroyed");
  error.name = "AbortError";
  return error;
}

export class GeometryWorkerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GeometryWorkerError";
  }
}

function geometryWorkerFailureError(message: string, cause?: unknown): GeometryWorkerError {
  return new GeometryWorkerError(message, cause === undefined ? undefined : { cause });
}

export class GeometryWorkerPool {
  readonly useWorker: boolean;
  worker: Worker | null = null;
  workerUrl: string | null = null;
  readonly pending = new Map<number, PendingResolve>();

  readonly clusterIndexIds = new Map<number, ClusterIndex["ids"]>();
  readonly clusterWasmStats: ClusterWasmWorkerStats = {
    attempts: 0,
    successes: 0,
    fallbacks: 0,
    recycledWorkers: 0,
    datasetInstalls: 0,
    datasetReuses: 0,
    datasetMisses: 0,
    datasetBytesTransferred: 0,
    avoidedCoordTransferBytes: 0,
    lastDatasetBytes: 0,
    lastWasmMemoryBytes: 0,
    lastOutputBytes: 0,
    lastScratchBytes: 0
  };
  private _recycleWorkerWhenIdle = false;
  private _workerEpoch = 0;
  private _nextClusterDatasetId = 0;
  private _clusterDataset: { workerEpoch: number; version: number; datasetId: number; count: number } | null = null;
  private _clusterDatasetInstallKey = "";
  private _clusterDatasetInstallPromise: Promise<number | null> | null = null;
  private _destroyed = false;

  constructor(options: GeometryWorkerOptions = {}) {
    this.useWorker = options.useWorker !== false && typeof Worker !== "undefined" && typeof URL !== "undefined";
  }

  async preparePoints(
    points: Iterable<GeometryPointInput> | AsyncIterable<GeometryPointInput>,
    options: GeometryPrepareOptions = {}
  ): Promise<PreparedPointBatch> {
    this.#throwIfDestroyed();
    if (!this.useWorker) return preparePointBatchAsync(points, options);
    const serialized = await collectPointInput(points, options);
    const worker = this.#worker();
    if (!worker) return preparePointBatchAsync(serialized, options);
    const id = ++requestId;
    return new Promise<PreparedPointBatch>((resolve, reject) => {
      this.pending.set(id, { type: "preparePoints", resolve, reject });
      this.#postMessage(worker, id, { id, type: "preparePoints", points: serialized });
    });
  }

  async clusterLayout(request: ClusterLayoutRequest): Promise<ClusterLayoutResult> {
    this.#throwIfDestroyed();
    if (!this.useWorker) return buildClusterLayout(request);
    const worker = this.#worker();
    if (!worker) return buildClusterLayout(request);
    const id = ++requestId;
    const coordsCopy = request.coords.slice();
    return new Promise<ClusterLayoutResult>((resolve, reject) => {
      this.pending.set(id, { type: "clusterLayout", resolve, reject });
      this.#postMessage(
        worker,
        id,
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

  /** Build one zoom in a worker without cloning arbitrary ids or retransferring persistent coords. */
  async greedyClusterLayout(request: ClusterGreedyWorkerRequest): Promise<ClusterLayoutResult> {
    this.#throwIfDestroyed();
    if (!this.useWorker) return buildGreedyClusterLayout(request);
    const worker = this.#worker();
    if (!worker) return buildGreedyClusterLayout(request);
    const datasetId = await this.#ensureClusterDataset(worker, request);
    this.#throwIfDestroyed();
    if (this.worker !== worker) return this.greedyClusterLayout(request);
    const id = ++requestId;
    return new Promise<ClusterLayoutResult>((resolve, reject) => {
      this.pending.set(id, {
        type: "greedyClusterLayout",
        request,
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
        },
        reject
      });
      if (datasetId != null) {
        const posted = this.#postMessage(worker, id, {
          id,
          type: "greedyClusterLayoutDataset",
          datasetId,
          zoomBucket: request.zoomBucket,
          gridSize: request.gridSize,
          minPoints: request.minPoints,
          clusterize: request.clusterize,
          clusterMaxZoom: request.clusterMaxZoom,
          clusterMinZoom: request.clusterMinZoom,
          simple: request.simple
        });
        if (posted) {
          this.clusterWasmStats.datasetReuses += 1;
          this.clusterWasmStats.avoidedCoordTransferBytes += request.coords.byteLength;
        }
        return;
      }
      this.#postLegacyGreedy(worker, id, request);
    });
  }

  /** Build transferable hierarchical index once; persistent worker dataset avoids repeated coord copies. */
  async clusterIndex(request: ClusterIndexWorkerRequest): Promise<ClusterIndex> {
    this.#throwIfDestroyed();
    if (!this.useWorker) return buildClusterIndex(request);
    const worker = this.#worker();
    if (!worker) return buildClusterIndex(request);
    const datasetId = await this.#ensureClusterDataset(worker, request);
    this.#throwIfDestroyed();
    if (this.worker !== worker) return this.clusterIndex(request);
    const id = ++requestId;
    this.clusterIndexIds.set(id, request.ids);
    return new Promise<ClusterIndex>((resolve, reject) => {
      this.clusterWasmStats.attempts += 1;
      this.pending.set(id, {
        type: "clusterIndex",
        request,
        resolve: (index: ClusterIndex) => {
          index.ids = request.ids;
          resolve(index);
        },
        reject
      });
      if (datasetId != null) {
        const posted = this.#postMessage(worker, id, {
          id,
          type: "clusterIndexDataset",
          datasetId,
          gridSize: request.gridSize,
          minPoints: request.minPoints,
          clusterize: request.clusterize,
          clusterMaxZoom: request.clusterMaxZoom,
          clusterMinZoom: request.clusterMinZoom,
          simple: request.simple
        });
        if (posted) {
          this.clusterWasmStats.datasetReuses += 1;
          this.clusterWasmStats.avoidedCoordTransferBytes += request.coords.byteLength;
        }
        return;
      }
      this.#postLegacyClusterIndex(worker, id, request);
    });
  }

  async #ensureClusterDataset(
    worker: Worker,
    request: { coords: Float64Array | Float32Array; __datasetVersion?: number }
  ): Promise<number | null> {
    this.#throwIfDestroyed();
    const version = Number(request.__datasetVersion);
    if (!Number.isFinite(version)) return null;
    if (
      this._clusterDataset &&
      this._clusterDataset.workerEpoch === this._workerEpoch &&
      this._clusterDataset.version === version &&
      this._clusterDataset.count === Math.floor(request.coords.length / 2)
    ) {
      return this._clusterDataset.datasetId;
    }

    const key = `${this._workerEpoch}:${version}:${request.coords.length}`;
    if (this._clusterDatasetInstallPromise && this._clusterDatasetInstallKey === key) {
      return this._clusterDatasetInstallPromise;
    }

    const installRequestId = ++requestId;
    const datasetId = ++this._nextClusterDatasetId;
    const coordsCopy = request.coords.slice();
    const workerEpoch = this._workerEpoch;
    const promise = new Promise<number | null>((resolve, reject) => {
      this.pending.set(installRequestId, {
        type: "clusterDatasetInstall",
        datasetId,
        resolve: (ok) => resolve(ok ? datasetId : null),
        reject
      });
      this.#postMessage(
        worker,
        installRequestId,
        { id: installRequestId, type: "clusterDatasetInstall", datasetId, coords: coordsCopy },
        [coordsCopy.buffer]
      );
    }).then((installedId) => {
      if (installedId != null && workerEpoch === this._workerEpoch) {
        this._clusterDataset = {
          workerEpoch,
          version,
          datasetId: installedId,
          count: Math.floor(request.coords.length / 2)
        };
        this.clusterWasmStats.datasetInstalls += 1;
        this.clusterWasmStats.datasetBytesTransferred += request.coords.byteLength;
        this.clusterWasmStats.lastDatasetBytes = request.coords.byteLength;
      }
      return installedId;
    }).finally(() => {
      if (this._clusterDatasetInstallPromise === promise) {
        this._clusterDatasetInstallPromise = null;
        this._clusterDatasetInstallKey = "";
      }
    });
    this._clusterDatasetInstallKey = key;
    this._clusterDatasetInstallPromise = promise;
    return promise;
  }

  #postLegacyGreedy(worker: Worker, id: number, request: ClusterGreedyWorkerRequest): void {
    const coordsCopy = request.coords.slice();
    this.#postMessage(
      worker,
      id,
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
  }

  #postLegacyClusterIndex(worker: Worker, id: number, request: ClusterIndexWorkerRequest): void {
    const coordsCopy = request.coords.slice();
    this.#postMessage(
      worker,
      id,
      {
        id,
        type: "clusterIndex",
        coords: coordsCopy,
        gridSize: request.gridSize,
        minPoints: request.minPoints,
        clusterize: request.clusterize,
        clusterMaxZoom: request.clusterMaxZoom,
        clusterMinZoom: request.clusterMinZoom,
        simple: request.simple
      },
      [coordsCopy.buffer]
    );
  }

  #postMessage(worker: Worker, id: number, message: unknown, transfer: Transferable[] = []): boolean {
    try {
      worker.postMessage(message, transfer);
      return true;
    } catch (cause) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        this.clusterIndexIds.delete(id);
        pending.reject(geometryWorkerFailureError(`Failed to send ${pending.type} request to geometry worker`, cause));
        this.#recycleWorkerIfIdle();
      }
      return false;
    }
  }

  getClusterWasmStats(): Readonly<ClusterWasmWorkerStats> {
    return { ...this.clusterWasmStats };
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    const error = geometryWorkerAbortError();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.clusterIndexIds.clear();
    this._recycleWorkerWhenIdle = false;
    this._clusterDataset = null;
    this._clusterDatasetInstallKey = "";
    this._clusterDatasetInstallPromise = null;
    this._workerEpoch += 1;
  }

  #recycleWorkerIfIdle(): void {
    if (this._destroyed || !this._recycleWorkerWhenIdle || this.pending.size !== 0) return;
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    this._recycleWorkerWhenIdle = false;
    this._clusterDataset = null;
    this._clusterDatasetInstallKey = "";
    this._clusterDatasetInstallPromise = null;
    this._workerEpoch += 1;
    this.clusterWasmStats.recycledWorkers += 1;
  }

  #worker(): Worker | null {
    this.#throwIfDestroyed();
    if (this.worker) return this.worker;
    try {
      const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
      this.workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(this.workerUrl);
      const activeWorker = this.worker;
      this._workerEpoch += 1;
      this._clusterDataset = null;
      this._clusterDatasetInstallKey = "";
      this._clusterDatasetInstallPromise = null;
      activeWorker.onmessage = (event) => {
        this.#handleWorkerMessage(activeWorker, event);
      };
      activeWorker.onerror = (event) => {
        event.preventDefault();
        const detail = event.message ? `: ${event.message}` : "";
        this.#failWorker(activeWorker, geometryWorkerFailureError(`Geometry worker failed${detail}`, event.error ?? event));
      };
      activeWorker.onmessageerror = (event) => {
        this.#failWorker(
          activeWorker,
          geometryWorkerFailureError("Geometry worker returned an unreadable message", event)
        );
      };
      return activeWorker;
    } catch {
      if (this.workerUrl) {
        URL.revokeObjectURL(this.workerUrl);
        this.workerUrl = null;
      }
      this.worker = null;
      this._clusterDataset = null;
      this._clusterDatasetInstallKey = "";
      this._clusterDatasetInstallPromise = null;
      this._workerEpoch += 1;
      return null;
    }
  }

  #handleWorkerMessage(worker: Worker, event: MessageEvent): void {
    if (this.worker !== worker) return;
    const data = event.data || {};
    const pending = this.pending.get(data.id);
    if (!pending) return;
    if (data.type === "clusterDatasetMissing") {
      this.clusterWasmStats.datasetMisses += 1;
      this._clusterDataset = null;
      if (pending.type === "greedyClusterLayout" || pending.type === "clusterIndex") {
        this.clusterWasmStats.datasetReuses = Math.max(0, this.clusterWasmStats.datasetReuses - 1);
        this.clusterWasmStats.avoidedCoordTransferBytes = Math.max(
          0,
          this.clusterWasmStats.avoidedCoordTransferBytes - pending.request.coords.byteLength
        );
      }
      if (pending.type === "greedyClusterLayout") {
        this.#postLegacyGreedy(this.worker!, Number(data.id), pending.request);
      } else if (pending.type === "clusterIndex") {
        this.#postLegacyClusterIndex(this.worker!, Number(data.id), pending.request);
      } else {
        this.#rejectUnexpectedResponse(data, pending);
      }
      return;
    }

    this.pending.delete(data.id);
    try {
      if (pending.type === "clusterDatasetInstall" && data.type === "clusterDatasetReady") {
        pending.resolve(Boolean(data.ok) && Number(data.datasetId) === pending.datasetId);
        return;
      }
      if (pending.type === "preparePoints" && data.type === "preparePoints") {
        pending.resolve({ points: new Float32Array(data.points), count: data.count, skipped: data.skipped });
        this.#recycleWorkerIfIdle();
        return;
      }
      if (pending.type === "clusterLayout" && data.type === "clusterLayout") {
        pending.resolve({ clusters: data.clusters || [], singles: data.singles || [] });
        this.#recycleWorkerIfIdle();
        return;
      }
      if (pending.type === "greedyClusterLayout" && data.type === "greedyClusterLayout") {
        pending.resolve({ clusters: data.clusters || [], singles: data.singles || [] });
        this.#recycleWorkerIfIdle();
        return;
      }
      if (pending.type === "clusterIndex" && data.type === "clusterIndexWasm") {
        const blob = data.blob instanceof ArrayBuffer ? data.blob : null;
        const index = blob ? decodeClusterIndexWasmBlob(blob) : null;
        if (index) {
          this.clusterWasmStats.successes += 1;
          this.clusterWasmStats.lastWasmMemoryBytes = Number(data.wasmMemoryBytes) || 0;
          this.clusterWasmStats.lastOutputBytes = Number(data.outputBytes) || blob!.byteLength;
          this.clusterWasmStats.lastScratchBytes = Number(data.scratchBytes) || 0;
          const ids = this.clusterIndexIds.get(data.id);
          this.clusterIndexIds.delete(data.id);
          if (ids) {
            index.ids = ids.length === index.leafCount
              ? ids
              : ids.slice(0, index.leafCount);
          }
          pending.resolve(index);
        } else {
          this.clusterWasmStats.fallbacks += 1;
          this.clusterIndexIds.delete(data.id);
          pending.resolve(buildClusterIndex(pending.request));
        }
        if (data.recycleRecommended) this._recycleWorkerWhenIdle = true;
        this.#recycleWorkerIfIdle();
        return;
      }
      if (pending.type === "clusterIndex" && data.type === "clusterIndex") {
        this.clusterWasmStats.fallbacks += 1;
        const index = decodeClusterIndex(data.index || data);
        const ids = this.clusterIndexIds.get(data.id);
        this.clusterIndexIds.delete(data.id);
        if (ids) {
          index.ids = ids.length === index.leafCount
            ? ids
            : ids.slice(0, index.leafCount);
        }
        pending.resolve(index);
        this.#recycleWorkerIfIdle();
        return;
      }
      this.#rejectUnexpectedResponse(data, pending);
    } catch (cause) {
      this.clusterIndexIds.delete(data.id);
      pending.reject(geometryWorkerFailureError(`Failed to process ${pending.type} worker response`, cause));
      this.#recycleWorkerIfIdle();
    }
  }

  #rejectUnexpectedResponse(data: { id?: unknown; type?: unknown }, pending: PendingResolve): void {
    this.pending.delete(Number(data.id));
    this.clusterIndexIds.delete(Number(data.id));
    const responseType = typeof data.type === "string" ? data.type : "unknown";
    pending.reject(geometryWorkerFailureError(
      `Unexpected geometry worker response "${responseType}" for ${pending.type} request`
    ));
    this.#recycleWorkerIfIdle();
  }

  #failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    worker.terminate();
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.clusterIndexIds.clear();
    this._recycleWorkerWhenIdle = false;
    this._clusterDataset = null;
    this._clusterDatasetInstallKey = "";
    this._clusterDatasetInstallPromise = null;
    this._workerEpoch += 1;
    for (const request of pending) request.reject(error);
  }

  #throwIfDestroyed(): void {
    if (this._destroyed) throw geometryWorkerAbortError();
  }
}

let sharedGeometryWorkerPool: GeometryWorkerPool | null = null;

/** Creates a caller-owned pool. The caller must eventually call destroy(). */
export function createGeometryWorkerPool(options: GeometryWorkerOptions = {}): GeometryWorkerPool {
  return new GeometryWorkerPool(options);
}

/** @internal Shared infrastructure for library-managed services. */
export function getSharedGeometryWorkerPool(): GeometryWorkerPool {
  if (!sharedGeometryWorkerPool) {
    sharedGeometryWorkerPool = createGeometryWorkerPool();
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
  if (!Array.isArray(source) && (!Number.isFinite(source.lat) || !Number.isFinite(source.lng))) return null;
  const point = latLng(source);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return [point.lat, point.lng];
}

const WORKER_SOURCE = `${clusterLayoutWorkerSource()}\n${clusterIndexWasmWorkerAddonSource()}`;
