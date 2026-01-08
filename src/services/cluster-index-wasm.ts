import type { ClusterIndex } from "./cluster-layout.js";
import { alignWasm8, decodeBase64Bytes, tryGrowWasmMemory } from "./wasm-utils.js";

export interface ClusterIndexWasmOptions {
  gridSize?: number;
  minPoints?: number;
  clusterize?: boolean;
  clusterMaxZoom?: number;
  clusterMinZoom?: number;
  simple?: boolean;
  /** Internal benchmark hook. */
  __clusterIndexWasmProfile?: Record<string, number | boolean | string>;
}

interface ClusterWasm {
  memory: WebAssembly.Memory;
  heapBase: number;
  scratchBytes: (count: number, maxZoom: number, minZoom: number) => number;
  outputMaxBytes: (count: number, maxZoom: number, minZoom: number) => number;
  resultPtr: () => number;
  peakEnd: () => number;
  treeBytes: () => number;
  permanentBytes: () => number;
  transientBytes: () => number;
  growPages: () => number;
  build: (
    coordsPtr: number,
    count: number,
    radius: number,
    minPoints: number,
    clusterize: number,
    maxZoom: number,
    minZoom: number,
    simple: number,
    scratchPtr: number,
    scratchBytes: number,
    outputPtr: number,
    outputCapacity: number
  ) => number;
}

const MAGIC = 0x3143574f;
const VERSION = 1;
const HEADER_WORDS = 32;
const HEADER_BYTES = HEADER_WORDS * 4;

let clusterWasm: ClusterWasm | null | undefined;
let clusterWasmLoadError = "";

// clang --target=wasm32 -O3 -mbulk-memory -fno-builtin -nostdlib scripts/wasm/cluster-index.c
// Whole-index numeric kernel: projection -> spatial grid -> hierarchy -> compact blob.
const CLUSTER_INDEX_WASM_BASE64 = "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SCAyICk2AkQgMiANNgJAIDIgKTYCPCAyIAg2AjggMiApNgI0IDIgAzYCMCAyIBM2AiAgMiAYNgIcIDIgGTYCGCAyIAU2AhQgMiApNgIQIDIgATYCDCAyIDQ2AgggMkLPro2KEzcDAEEAIRYgMkEANgIkIDIgD70iED4CKCAyIBBCIIg+AiwgE0EBIBNBAUsbIhJBAXEhBAJAIBNBAkkNACASQX5xISZBACEWIDEhESAyIRIgMyEOA0AgEkGAAWogDigCAEECdCAXajYCACASQYQBaiARKAIANgIAIBJBiAFqIA5BBGooAgBBAnQgF2o2AgAgEkGMAWogEUEEaigCADYCACARQQhqIREgEkEQaiESIA5BCGohDiAmIBZBAmoiFkcNAAsLAkAgBEUNACAyQYABaiAWQQN0aiISIDMgFkECdCIRaigCAEECdCAXajYCACASQQRqIDEgEWooAgA2AgALAkAgKUUNACAuIAFrISYgBUEBaiEEIB8gAUEDdCISayEOICwgAUECdCIRayEgICogEWshNiAiIBJrIRZBACESQQAhEQNAIDIgA2ogHCsDADkDACAyIAhqIB4rAwA5AwAgMiANaiAAIA4gESABSRsrAwA5AwAgMiAJaiEXAkACQCARIAFPDQAgF0EBNgIAIDIgPWogAEEIaisDADkDACAyIAZqIAQ6AAAgMiAHaiA1IBJqKAIANgIAQX8hFwwBCyAyID1qIBYrAwA5AwAgFyA2IBJqKAIANgIAIDIgBmogJiARai0AADoAACAyIAdqIDUgEmooAgA2AgAgICASaigCACEXCyAyIAxqIBc2AgAgMiA4aiAtIBJqKAIANgIAIAlBBGohCSAOQQhqIQ4gFkEIaiEWIABBEGohACAcQQhqIRwgA0EIaiEDIB5BCGohHiAIQQhqIQggDUEIaiENID1BCGohPSAGQQFqIQYgB0EEaiEHIAxBBGohDCASQQRqIRIgOEEEaiE4ICkgEUEBaiIRRw0ACwtBACAyNgKAiICAACA0IRYLIBYLAPgBBG5hbWUAExJjbHVzdGVyLWluZGV4Lndhc20BxwEJABVjbHVzdGVyX3NjcmF0Y2hfYnl0ZXMBGGNsdXN0ZXJfb3V0cHV0X21heF9ieXRlcwISY2x1c3Rlcl9yZXN1bHRfcHRyAxBjbHVzdGVyX3BlYWtfZW5kBBJjbHVzdGVyX3RyZWVfYnl0ZXMFF2NsdXN0ZXJfcGVybWFuZW50X2J5dGVzBhdjbHVzdGVyX3RyYW5zaWVudF9ieXRlcwcSY2x1c3Rlcl9ncm93X3BhZ2VzCBNidWlsZF9jbHVzdGVyX2luZGV4BxIBAA9fX3N0YWNrX3BvaW50ZXIAfwlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQEFY2xhbmdfMTcuMC4wIChodHRwczovL2dpdGh1Yi5jb20vc3dpZnRsYW5nL2xsdm0tcHJvamVjdC5naXQgMTA5OTliNmQwMzRmZTMxOGYzZDU2YzgzYmRkYjY1NzI1OTNhOGJiMCkAVg90YXJnZXRfZmVhdHVyZXMFKwtidWxrLW1lbW9yeSsKbXVsdGl2YWx1ZSsPbXV0YWJsZS1nbG9iYWxzKw9yZWZlcmVuY2UtdHlwZXMrCHNpZ24tZXh0";

export function clusterIndexWasmSupported(): boolean {
  return loadClusterWasm() != null;
}

export function clusterIndexWasmError(): string {
  loadClusterWasm();
  return clusterWasmLoadError;
}

/** Stable result: one WASM build -> one snapshot copy -> typed-array views. ids stay on the JS/main-thread side. */
export function buildClusterIndexWasm(
  coords: Float64Array | Float32Array,
  options: ClusterIndexWasmOptions = {}
): ClusterIndex | null {
  return buildClusterIndexWasmMode(coords, options, true);
}

/** Benchmark-only live views. Invalid after the next build or WebAssembly.Memory.grow(). */
export function buildClusterIndexWasmUnsafe(
  coords: Float64Array | Float32Array,
  options: ClusterIndexWasmOptions = {}
): ClusterIndex | null {
  return buildClusterIndexWasmMode(coords, options, false);
}

function buildClusterIndexWasmMode(
  coords: Float64Array | Float32Array,
  options: ClusterIndexWasmOptions,
  stableSnapshot: boolean
): ClusterIndex | null {
  const profile = options.__clusterIndexWasmProfile;
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const started = profile ? now() : 0;
  const wasm = loadClusterWasm();
  const loadFinished = profile ? now() : 0;
  if (!wasm) return null;

  const count = Math.floor(coords.length / 2);
  const maxZoom = clampZoom(options.clusterMaxZoom ?? 8);
  const minZoom = Math.min(maxZoom, clampZoom(options.clusterMinZoom ?? 0));
  const radius = Math.max(20, Number(options.gridSize) || 50);
  const minPoints = Math.max(2, Math.floor(options.minPoints ?? 2));
  const scratchBytes = wasm.scratchBytes(count, maxZoom, minZoom) >>> 0;
  const legacyOutputReserve = wasm.outputMaxBytes(count, maxZoom, minZoom) >>> 0;
  if (count > 0 && scratchBytes === 0) return null;

  const inputPtr = alignWasm8(wasm.heapBase);
  const inputBytes = count * 2 * 8;
  const scratchPtr = alignWasm8(inputPtr + inputBytes);
  // P2 reserves only fixed workspace up front. The kernel grows linear memory
  // by actual tree/result demand and reuses transient scratch for the final blob.
  const requiredBytes = scratchPtr + scratchBytes;

  const memoryStarted = profile ? now() : 0;
  if (!tryGrowWasmMemory(wasm.memory, requiredBytes)) {
    clusterWasmLoadError = `cluster index WASM memory requirement too large: ${requiredBytes}`;
    return null;
  }
  const memoryFinished = profile ? now() : 0;

  const copyStarted = profile ? now() : 0;
  new Float64Array(wasm.memory.buffer, inputPtr, count * 2).set(coords);
  const copyFinished = profile ? now() : 0;

  const wasmStarted = profile ? now() : 0;
  const resultBytes = wasm.build(
    inputPtr,
    count,
    radius,
    minPoints,
    options.clusterize === false ? 0 : 1,
    maxZoom,
    minZoom,
    options.simple === true ? 1 : 0,
    scratchPtr,
    scratchBytes,
    0,
    0
  );
  const wasmFinished = profile ? now() : 0;
  if (resultBytes <= 0) {
    clusterWasmLoadError = `cluster index WASM build failed: ${resultBytes}`;
    return null;
  }

  const resultPtr = wasm.resultPtr() >>> 0;
  if (resultPtr === 0 || resultPtr + resultBytes > wasm.memory.buffer.byteLength) {
    clusterWasmLoadError = "cluster index WASM returned an invalid result range";
    return null;
  }

  const snapshotStarted = profile ? now() : 0;
  const buffer = stableSnapshot
    ? wasm.memory.buffer.slice(resultPtr, resultPtr + resultBytes)
    : wasm.memory.buffer;
  const baseOffset = stableSnapshot ? 0 : resultPtr;
  const snapshotFinished = profile ? now() : 0;

  const viewsStarted = profile ? now() : 0;
  const index = decodeClusterBlob(buffer, baseOffset, resultBytes);
  const viewsFinished = profile ? now() : 0;
  if (!index) return null;

  if (profile) {
    const peakEnd = wasm.peakEnd() >>> 0;
    profile.clusterIndexWasm = true;
    profile.clusterIndexWasmP2 = true;
    profile.snapshot = stableSnapshot;
    profile.count = count;
    profile.nodeCount = index.nodeCount;
    profile.treeEntries = index.trees.reduce((sum, tree) => sum + tree.length, 0);
    profile.inputBytes = inputBytes;
    profile.scratchBytes = scratchBytes;
    profile.permanentBytes = wasm.permanentBytes() >>> 0;
    profile.transientBytes = wasm.transientBytes() >>> 0;
    profile.treeScratchBytes = wasm.treeBytes() >>> 0;
    profile.outputCapacityBytes = legacyOutputReserve;
    profile.outputBytes = resultBytes;
    profile.activeLinearBytes = peakEnd > inputPtr ? peakEnd - inputPtr : 0;
    profile.wasmMemoryBytes = wasm.memory.buffer.byteLength;
    profile.kernelGrowPages = wasm.growPages() >>> 0;
    profile.moduleLoadMs = loadFinished - started;
    profile.memoryGrowMs = memoryFinished - memoryStarted;
    profile.inputCopyMs = copyFinished - copyStarted;
    profile.wasmBuildMs = wasmFinished - wasmStarted;
    profile.snapshotMs = snapshotFinished - snapshotStarted;
    profile.viewsMs = viewsFinished - viewsStarted;
    profile.totalMs = viewsFinished - started;
  }
  return index;
}

export function decodeClusterIndexWasmBlob(buffer: ArrayBuffer): ClusterIndex | null {
  return decodeClusterBlob(buffer, 0, buffer.byteLength);
}

function decodeClusterBlob(buffer: ArrayBuffer, baseOffset: number, byteLength: number): ClusterIndex | null {
  if (byteLength < HEADER_BYTES) return null;
  const h = new Uint32Array(buffer, baseOffset, HEADER_WORDS);
  if (h[0] !== MAGIC || h[1] !== VERSION || h[2] > byteLength) return null;
  const view = new DataView(buffer, baseOffset, byteLength);
  const total = h[2];
  const f64 = (offset: number, length: number): Float64Array => {
    if (offset + length * 8 > total) throw new RangeError("cluster WASM f64 view outside blob");
    return new Float64Array(buffer, baseOffset + offset, length);
  };
  const u32 = (offset: number, length: number): Uint32Array => {
    if (offset + length * 4 > total) throw new RangeError("cluster WASM u32 view outside blob");
    return new Uint32Array(buffer, baseOffset + offset, length);
  };
  const i32 = (offset: number, length: number): Int32Array => {
    if (offset + length * 4 > total) throw new RangeError("cluster WASM i32 view outside blob");
    return new Int32Array(buffer, baseOffset + offset, length);
  };
  const i8 = (offset: number, length: number): Int8Array => {
    if (offset + length > total) throw new RangeError("cluster WASM i8 view outside blob");
    return new Int8Array(buffer, baseOffset + offset, length);
  };
  try {
    const treeCount = h[31];
    const treeDescOffset = h[30];
    if (treeDescOffset + treeCount * 8 > total) return null;
    const desc = new Uint32Array(buffer, baseOffset + treeDescOffset, treeCount * 2);
    const trees = new Array<Int32Array>(treeCount);
    for (let z = 0; z < treeCount; z++) trees[z] = i32(desc[z * 2], desc[z * 2 + 1]);
    return {
      leafCount: h[3],
      nodeCount: h[4],
      maxZoom: h[5],
      minZoom: h[6],
      minPoints: h[7],
      radius: view.getFloat64(40, true),
      ids: [],
      x: f64(h[12], h[13]),
      y: f64(h[14], h[15]),
      lat: f64(h[16], h[17]),
      lng: f64(h[18], h[19]),
      weight: u32(h[20], h[21]),
      zoom: i8(h[22], h[23]),
      parent: i32(h[24], h[25]),
      firstChild: i32(h[26], h[27]),
      nextSibling: i32(h[28], h[29]),
      trees
    };
  } catch {
    return null;
  }
}

function loadClusterWasm(): ClusterWasm | null {
  if (clusterWasm !== undefined) return clusterWasm;
  clusterWasm = null;
  if (typeof WebAssembly === "undefined") {
    clusterWasmLoadError = "WebAssembly is unavailable";
    return null;
  }
  try {
    const binary = decodeBase64Bytes(CLUSTER_INDEX_WASM_BASE64);
    const module = new WebAssembly.Module(binary);
    const instance = new WebAssembly.Instance(module, {});
    const exported = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      __heap_base: WebAssembly.Global;
      cluster_scratch_bytes: ClusterWasm["scratchBytes"];
      cluster_output_max_bytes: ClusterWasm["outputMaxBytes"];
      cluster_result_ptr: ClusterWasm["resultPtr"];
      cluster_peak_end: ClusterWasm["peakEnd"];
      cluster_tree_bytes: ClusterWasm["treeBytes"];
      cluster_permanent_bytes: ClusterWasm["permanentBytes"];
      cluster_transient_bytes: ClusterWasm["transientBytes"];
      cluster_grow_pages: ClusterWasm["growPages"];
      build_cluster_index: ClusterWasm["build"];
    };
    if (
      !exported.memory ||
      !exported.__heap_base ||
      typeof exported.cluster_scratch_bytes !== "function" ||
      typeof exported.cluster_output_max_bytes !== "function" ||
      typeof exported.cluster_result_ptr !== "function" ||
      typeof exported.cluster_peak_end !== "function" ||
      typeof exported.cluster_tree_bytes !== "function" ||
      typeof exported.cluster_permanent_bytes !== "function" ||
      typeof exported.cluster_transient_bytes !== "function" ||
      typeof exported.cluster_grow_pages !== "function" ||
      typeof exported.build_cluster_index !== "function"
    ) {
      clusterWasmLoadError = "cluster index WASM exports missing";
      return null;
    }
    clusterWasm = {
      memory: exported.memory,
      heapBase: Number(exported.__heap_base.value),
      scratchBytes: exported.cluster_scratch_bytes,
      outputMaxBytes: exported.cluster_output_max_bytes,
      resultPtr: exported.cluster_result_ptr,
      peakEnd: exported.cluster_peak_end,
      treeBytes: exported.cluster_tree_bytes,
      permanentBytes: exported.cluster_permanent_bytes,
      transientBytes: exported.cluster_transient_bytes,
      growPages: exported.cluster_grow_pages,
      build: exported.build_cluster_index
    };
    return clusterWasm;
  } catch (error) {
    clusterWasmLoadError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(30, Math.floor(value)));
}


const CLUSTER_WASM_RECYCLE_MEMORY_BYTES = 192 * 1024 * 1024;

/**
 * Classic-worker addon installed after clusterLayoutWorkerSource().
 * It intercepts only `clusterIndex`, attempts the whole-index WASM kernel,
 * and delegates to the original JS worker handler on any unsupported/error path.
 */
function clusterIndexWasmWorkerAddonMain(base64: string, recycleMemoryBytes: number): void {
  const scope = globalThis as typeof globalThis & {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
  };
  const previous = scope.onmessage;
  let state: {
    memory: WebAssembly.Memory;
    heapBase: number;
    scratchBytes: (count: number, maxZoom: number, minZoom: number) => number;
    resultPtr: () => number;
    peakEnd: () => number;
    treeBytes: () => number;
    permanentBytes: () => number;
    transientBytes: () => number;
    growPages: () => number;
    build: (
      coordsPtr: number,
      count: number,
      radius: number,
      minPoints: number,
      clusterize: number,
      maxZoom: number,
      minZoom: number,
      simple: number,
      scratchPtr: number,
      scratchBytes: number,
      outputPtr: number,
      outputCapacity: number
    ) => number;
  } | null | undefined;
  let dataset: {
    id: unknown;
    ptr: number;
    count: number;
    byteLength: number;
  } | null = null;

  const align8 = (value: number): number => (value + 7) & ~7;
  const clampZoom = (value: unknown): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(30, Math.floor(n)));
  };
  const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> => {
    const raw = atob(value);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  const load = () => {
    if (state !== undefined) return state;
    state = null;
    try {
      if (typeof WebAssembly === "undefined") return null;
      const binary = decodeBase64(base64);
      const module = new WebAssembly.Module(binary);
      const instance = new WebAssembly.Instance(module, {});
      const exported = instance.exports as unknown as {
        memory: WebAssembly.Memory;
        __heap_base: WebAssembly.Global;
        cluster_scratch_bytes: (count: number, maxZoom: number, minZoom: number) => number;
        cluster_result_ptr: () => number;
        cluster_peak_end: () => number;
        cluster_tree_bytes: () => number;
        cluster_permanent_bytes: () => number;
        cluster_transient_bytes: () => number;
        cluster_grow_pages: () => number;
        build_cluster_index: (
          coordsPtr: number,
          count: number,
          radius: number,
          minPoints: number,
          clusterize: number,
          maxZoom: number,
          minZoom: number,
          simple: number,
          scratchPtr: number,
          scratchBytes: number,
          outputPtr: number,
          outputCapacity: number
        ) => number;
      };
      if (
        !exported.memory ||
        !exported.__heap_base ||
        typeof exported.cluster_scratch_bytes !== "function" ||
        typeof exported.cluster_result_ptr !== "function" ||
        typeof exported.cluster_peak_end !== "function" ||
        typeof exported.cluster_tree_bytes !== "function" ||
        typeof exported.cluster_permanent_bytes !== "function" ||
        typeof exported.cluster_transient_bytes !== "function" ||
        typeof exported.cluster_grow_pages !== "function" ||
        typeof exported.build_cluster_index !== "function"
      ) {
        return null;
      }
      state = {
        memory: exported.memory,
        heapBase: Number(exported.__heap_base.value),
        scratchBytes: exported.cluster_scratch_bytes,
        resultPtr: exported.cluster_result_ptr,
        peakEnd: exported.cluster_peak_end,
        treeBytes: exported.cluster_tree_bytes,
        permanentBytes: exported.cluster_permanent_bytes,
        transientBytes: exported.cluster_transient_bytes,
        growPages: exported.cluster_grow_pages,
        build: exported.build_cluster_index
      };
      return state;
    } catch {
      return null;
    }
  };
  const ensureMemory = (memory: WebAssembly.Memory, bytes: number): boolean => {
    if (bytes <= memory.buffer.byteLength) return true;
    try {
      memory.grow(Math.ceil((bytes - memory.buffer.byteLength) / 65_536));
      return bytes <= memory.buffer.byteLength;
    } catch {
      return false;
    }
  };
  const fallback = (event: MessageEvent): void => {
    if (previous) previous.call(scope, event);
  };
  const postDatasetMissing = (data: { id?: unknown; datasetId?: unknown }): void => {
    scope.postMessage({ id: data.id, type: "clusterDatasetMissing", datasetId: data.datasetId });
  };
  const activeDatasetView = (wasm: NonNullable<typeof state>): Float64Array | null => {
    if (!dataset) return null;
    const end = dataset.ptr + dataset.byteLength;
    if (end > wasm.memory.buffer.byteLength) return null;
    return new Float64Array(wasm.memory.buffer, dataset.ptr, dataset.count * 2);
  };
  const runBuild = (
    data: {
      id?: unknown;
      gridSize?: number;
      minPoints?: number;
      clusterize?: boolean;
      clusterMaxZoom?: number;
      clusterMinZoom?: number;
      simple?: boolean;
    },
    wasm: NonNullable<typeof state>,
    coordsPtr: number,
    count: number,
    inputReused: boolean
  ): boolean => {
    const maxZoom = clampZoom(data.clusterMaxZoom ?? 8);
    const minZoom = Math.min(maxZoom, clampZoom(data.clusterMinZoom ?? 0));
    const radius = Math.max(20, Number(data.gridSize) || 50);
    const minPoints = Math.max(2, Math.floor(Number(data.minPoints) || 2));
    const scratchBytes = wasm.scratchBytes(count, maxZoom, minZoom) >>> 0;
    if (count > 0 && scratchBytes === 0) return false;
    const inputBytes = count * 2 * 8;
    const scratchPtr = align8(coordsPtr + inputBytes);
    if (!ensureMemory(wasm.memory, scratchPtr + scratchBytes)) return false;

    const resultBytes = wasm.build(
      coordsPtr,
      count,
      radius,
      minPoints,
      data.clusterize === false ? 0 : 1,
      maxZoom,
      minZoom,
      data.simple === true ? 1 : 0,
      scratchPtr,
      scratchBytes,
      0,
      0
    );
    if (resultBytes <= 0) return false;

    const resultPtr = wasm.resultPtr() >>> 0;
    if (resultPtr === 0 || resultPtr + resultBytes > wasm.memory.buffer.byteLength) return false;
    const blob = wasm.memory.buffer.slice(resultPtr, resultPtr + resultBytes);
    const wasmMemoryBytes = wasm.memory.buffer.byteLength;
    scope.postMessage(
      {
        id: data.id,
        type: "clusterIndexWasm",
        blob,
        outputBytes: resultBytes,
        inputBytes,
        inputReused,
        scratchBytes,
        permanentBytes: wasm.permanentBytes() >>> 0,
        transientBytes: wasm.transientBytes() >>> 0,
        treeScratchBytes: wasm.treeBytes() >>> 0,
        activeLinearBytes: Math.max(0, (wasm.peakEnd() >>> 0) - coordsPtr),
        kernelGrowPages: wasm.growPages() >>> 0,
        wasmMemoryBytes,
        recycleRecommended: wasmMemoryBytes >= recycleMemoryBytes
      },
      [blob]
    );
    return true;
  };

  scope.onmessage = (event: MessageEvent) => {
    const data = (event.data || {}) as {
      id?: unknown;
      type?: string;
      datasetId?: unknown;
      coords?: Float64Array | Float32Array;
      gridSize?: number;
      minPoints?: number;
      clusterize?: boolean;
      clusterMaxZoom?: number;
      clusterMinZoom?: number;
      zoomBucket?: number;
      simple?: boolean;
    };

    if (data.type === "clusterDatasetInstall") {
      const coords = data.coords;
      const wasm = load();
      if (!wasm || (!(coords instanceof Float64Array) && !(coords instanceof Float32Array))) {
        scope.postMessage({ id: data.id, type: "clusterDatasetReady", datasetId: data.datasetId, ok: false });
        return;
      }
      try {
        const count = Math.floor(coords.length / 2);
        const ptr = align8(wasm.heapBase);
        const byteLength = count * 2 * 8;
        if (!ensureMemory(wasm.memory, ptr + byteLength)) {
          scope.postMessage({ id: data.id, type: "clusterDatasetReady", datasetId: data.datasetId, ok: false });
          return;
        }
        new Float64Array(wasm.memory.buffer, ptr, count * 2).set(coords.subarray(0, count * 2));
        dataset = { id: data.datasetId, ptr, count, byteLength };
        scope.postMessage({
          id: data.id,
          type: "clusterDatasetReady",
          datasetId: data.datasetId,
          ok: true,
          count,
          inputBytes: byteLength,
          wasmMemoryBytes: wasm.memory.buffer.byteLength
        });
      } catch {
        dataset = null;
        scope.postMessage({ id: data.id, type: "clusterDatasetReady", datasetId: data.datasetId, ok: false });
      }
      return;
    }

    if (data.type === "greedyClusterLayoutDataset" || data.type === "clusterLayoutDataset") {
      const wasm = load();
      if (!wasm || !dataset || dataset.id !== data.datasetId) {
        postDatasetMissing(data);
        return;
      }
      const coords = activeDatasetView(wasm);
      if (!coords || !previous) {
        postDatasetMissing(data);
        return;
      }
      const delegatedType = data.type === "greedyClusterLayoutDataset" ? "greedyClusterLayout" : "clusterLayout";
      previous.call(scope, {
        data: { ...data, type: delegatedType, coords }
      } as MessageEvent);
      return;
    }

    if (data.type === "clusterIndexDataset") {
      const wasm = load();
      if (!wasm || !dataset || dataset.id !== data.datasetId) {
        postDatasetMissing(data);
        return;
      }
      try {
        if (!runBuild(data, wasm, dataset.ptr, dataset.count, true)) postDatasetMissing(data);
      } catch {
        postDatasetMissing(data);
      }
      return;
    }

    if (data.type !== "clusterIndex") {
      fallback(event);
      return;
    }

    const coords = data.coords;
    if (!(coords instanceof Float64Array) && !(coords instanceof Float32Array)) {
      fallback(event);
      return;
    }

    try {
      const wasm = load();
      if (!wasm) {
        fallback(event);
        return;
      }
      const count = Math.floor(coords.length / 2);
      const inputPtr = align8(wasm.heapBase);
      const inputBytes = count * 2 * 8;
      if (!ensureMemory(wasm.memory, inputPtr + inputBytes)) {
        fallback(event);
        return;
      }
      new Float64Array(wasm.memory.buffer, inputPtr, count * 2).set(coords.subarray(0, count * 2));
      if (!runBuild(data, wasm, inputPtr, count, false)) fallback(event);
    } catch {
      fallback(event);
    }
  };
}

export function clusterIndexWasmWorkerAddonSource(): string {
  return `\n;(${clusterIndexWasmWorkerAddonMain.toString()})(${JSON.stringify(CLUSTER_INDEX_WASM_BASE64)},${CLUSTER_WASM_RECYCLE_MEMORY_BYTES});`;
}
