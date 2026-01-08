import { alignWasm4, alignWasm8, decodeBase64Bytes, tryGrowWasmMemory } from "./wasm-utils.js";

export interface PackedHeatContours {
  readonly buffer: ArrayBuffer;
  readonly cols: number;
  readonly rows: number;
  readonly levels: Float32Array;
  readonly lineOffsets: Uint32Array;
  readonly lineLevels: Uint32Array;
  readonly xy: Float32Array;
  readonly lineCount: number;
  readonly vertexCount: number;
}

export interface HeatContoursWasmProfile {
  supported?: boolean;
  stableSnapshot?: boolean;
  gridBytes?: number;
  levelsBytes?: number;
  scratchBytes?: number;
  outputBytes?: number;
  segments?: number;
  lines?: number;
  vertices?: number;
  wasmMemoryBytes?: number;
  moduleLoadMs?: number;
  memoryGrowMs?: number;
  inputCopyMs?: number;
  countMs?: number;
  buildMs?: number;
  snapshotMs?: number;
  viewsMs?: number;
  totalMs?: number;
}

interface HeatContourWasm {
  memory: WebAssembly.Memory;
  heapBase: number;
  scratchBytes: (cols: number, rows: number) => number;
  count: (
    gridPtr: number,
    cols: number,
    rows: number,
    levelsPtr: number,
    levelCount: number,
    scratchPtr: number,
    scratchBytes: number
  ) => number;
  build: (
    gridPtr: number,
    cols: number,
    rows: number,
    levelsPtr: number,
    levelCount: number,
    scratchPtr: number,
    scratchBytes: number,
    outputPtr: number,
    outputCapacity: number
  ) => number;
  lineCount: () => number;
  vertexCount: () => number;
  segmentCount: () => number;
}

const MAGIC = 0x31534948;
const VERSION = 1;
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;

let heatContourWasm: HeatContourWasm | null | undefined;
let heatContourWasmLoadError = "";

// clang --target=wasm32 -O3 -mbulk-memory -fno-builtin -nostdlib scripts/wasm/heat-isolines.c
const HEAT_ISOLINES_WASM_BASE64 = "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ACgCCCAAKAIQIgFBA3RqIgIgAzgCACACQQRqIAQ4AgALIAAgAUEBajYCEAsAkAIEbmFtZQATEmhlYXQtaXNvbGluZXMud2FzbQHfAQsAF2hlYXRfY29udG91cl9saW5lX2NvdW50ARloZWF0X2NvbnRvdXJfdmVydGV4X2NvdW50AhpoZWF0X2NvbnRvdXJfc2VnbWVudF9jb3VudAMaaGVhdF9jb250b3VyX3NjcmF0Y2hfYnl0ZXMEEmhlYXRfY29udG91cl9jb3VudAUOYnVpbGRfc2VnbWVudHMGDHRyYXZlcnNlX2FsbAcMZW1pdF9zZWdtZW50CA50cmF2ZXJzZV9jaGFpbgkSaGVhdF9jb250b3VyX2J1aWxkCgx3cml0ZV92ZXJ0ZXgHEgEAD19fc3RhY2tfcG9pbnRlcgB/CXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQVjbGFuZ18xNy4wLjAgKGh0dHBzOi8vZ2l0aHViLmNvbS9zd2lmdGxhbmcvbGx2bS1wcm9qZWN0LmdpdCAxMDk5OWI2ZDAzNGZlMzE4ZjNkNTZjODNiZGRiNjU3MjU5M2E4YmIwKQBWD3RhcmdldF9mZWF0dXJlcwUrC2J1bGstbWVtb3J5KwptdWx0aXZhbHVlKw9tdXRhYmxlLWdsb2JhbHMrD3JlZmVyZW5jZS10eXBlcysIc2lnbi1leHQ=";

export function heatContoursWasmSupported(): boolean {
  return loadHeatContourWasm() != null;
}

export function heatContoursWasmError(): string {
  loadHeatContourWasm();
  return heatContourWasmLoadError;
}

/** Stable result: scalar grid + thresholds -> WASM marching/stitching -> one snapshot blob. */
export function buildHeatContoursWasm(
  grid: Float32Array,
  cols: number,
  rows: number,
  levels: Float32Array | number[],
  profile?: HeatContoursWasmProfile
): PackedHeatContours | null {
  return buildHeatContoursWasmMode(grid, cols, rows, levels, true, profile);
}

/** Benchmark-only live views. Invalid after next call or WebAssembly.Memory.grow(). */
export function buildHeatContoursWasmUnsafe(
  grid: Float32Array,
  cols: number,
  rows: number,
  levels: Float32Array | number[],
  profile?: HeatContoursWasmProfile
): PackedHeatContours | null {
  return buildHeatContoursWasmMode(grid, cols, rows, levels, false, profile);
}

export function decodeHeatContoursWasmBlob(buffer: ArrayBuffer): PackedHeatContours | null {
  return decodePackedHeatContours(buffer, 0, buffer.byteLength);
}

function buildHeatContoursWasmMode(
  grid: Float32Array,
  colsRaw: number,
  rowsRaw: number,
  levelsLike: Float32Array | number[],
  stableSnapshot: boolean,
  profile?: HeatContoursWasmProfile
): PackedHeatContours | null {
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const started = profile ? now() : 0;
  const wasm = loadHeatContourWasm();
  const loaded = profile ? now() : 0;
  if (!wasm) return null;

  const cols = Math.max(2, Math.floor(colsRaw));
  const rows = Math.max(2, Math.floor(rowsRaw));
  if (grid.length < cols * rows) return null;
  const levels = levelsLike instanceof Float32Array ? levelsLike : Float32Array.from(levelsLike);
  if (!levels.length) return emptyPacked(cols, rows);

  const gridBytes = cols * rows * 4;
  const levelsBytes = levels.length * 4;
  const scratchBytes = wasm.scratchBytes(cols, rows) >>> 0;
  if (!scratchBytes) return null;

  const gridPtr = alignWasm8(wasm.heapBase);
  const levelsPtr = alignWasm4(gridPtr + gridBytes);
  const scratchPtr = alignWasm8(levelsPtr + levelsBytes);
  const countRequired = scratchPtr + scratchBytes;

  const growStarted = profile ? now() : 0;
  if (!tryGrowWasmMemory(wasm.memory, countRequired)) return null;
  const grown = profile ? now() : 0;

  const copyStarted = profile ? now() : 0;
  new Float32Array(wasm.memory.buffer, gridPtr, cols * rows).set(grid.subarray(0, cols * rows));
  new Float32Array(wasm.memory.buffer, levelsPtr, levels.length).set(levels);
  const copied = profile ? now() : 0;

  const countStarted = profile ? now() : 0;
  const outputBytes = wasm.count(
    gridPtr,
    cols,
    rows,
    levelsPtr,
    levels.length,
    scratchPtr,
    scratchBytes
  ) >>> 0;
  const counted = profile ? now() : 0;
  if (!outputBytes) {
    heatContourWasmLoadError = "heat isolines WASM count failed";
    return null;
  }

  const outputPtr = alignWasm8(scratchPtr + scratchBytes);
  const outputEnd = outputPtr + outputBytes;
  if (!tryGrowWasmMemory(wasm.memory, outputEnd)) return null;

  const buildStarted = profile ? now() : 0;
  const builtBytes = wasm.build(
    gridPtr,
    cols,
    rows,
    levelsPtr,
    levels.length,
    scratchPtr,
    scratchBytes,
    outputPtr,
    outputBytes
  ) >>> 0;
  const built = profile ? now() : 0;
  if (builtBytes !== outputBytes || outputPtr + builtBytes > wasm.memory.buffer.byteLength) {
    heatContourWasmLoadError = "heat isolines WASM build failed";
    return null;
  }

  const snapshotStarted = profile ? now() : 0;
  const buffer = stableSnapshot
    ? wasm.memory.buffer.slice(outputPtr, outputPtr + builtBytes)
    : wasm.memory.buffer;
  const baseOffset = stableSnapshot ? 0 : outputPtr;
  const snapshotted = profile ? now() : 0;

  const viewsStarted = profile ? now() : 0;
  const decoded = decodePackedHeatContours(buffer, baseOffset, builtBytes);
  const viewsFinished = profile ? now() : 0;
  if (!decoded) return null;

  if (profile) {
    profile.supported = true;
    profile.stableSnapshot = stableSnapshot;
    profile.gridBytes = gridBytes;
    profile.levelsBytes = levelsBytes;
    profile.scratchBytes = scratchBytes;
    profile.outputBytes = outputBytes;
    profile.segments = wasm.segmentCount() >>> 0;
    profile.lines = decoded.lineCount;
    profile.vertices = decoded.vertexCount;
    profile.wasmMemoryBytes = wasm.memory.buffer.byteLength;
    profile.moduleLoadMs = loaded - started;
    profile.memoryGrowMs = grown - growStarted;
    profile.inputCopyMs = copied - copyStarted;
    profile.countMs = counted - countStarted;
    profile.buildMs = built - buildStarted;
    profile.snapshotMs = snapshotted - snapshotStarted;
    profile.viewsMs = viewsFinished - viewsStarted;
    profile.totalMs = viewsFinished - started;
  }
  return decoded;
}

function decodePackedHeatContours(
  buffer: ArrayBuffer,
  baseOffset: number,
  byteLength: number
): PackedHeatContours | null {
  if (byteLength < HEADER_BYTES || baseOffset < 0 || baseOffset + byteLength > buffer.byteLength) return null;
  const h = new Uint32Array(buffer, baseOffset, HEADER_WORDS);
  if (h[0] !== MAGIC || h[1] !== VERSION || h[2] > byteLength || h[2] < HEADER_BYTES) return null;
  const total = h[2];
  const f32 = (offset: number, length: number): Float32Array => {
    if (offset + length * 4 > total) throw new RangeError("heat isolines WASM f32 view outside blob");
    return new Float32Array(buffer, baseOffset + offset, length);
  };
  const u32 = (offset: number, length: number): Uint32Array => {
    if (offset + length * 4 > total) throw new RangeError("heat isolines WASM u32 view outside blob");
    return new Uint32Array(buffer, baseOffset + offset, length);
  };
  try {
    const levels = f32(h[8], h[9]);
    const lineOffsets = u32(h[10], h[11]);
    const lineLevels = u32(h[12], h[13]);
    const xy = f32(h[14], h[15]);
    if (lineOffsets.length !== h[6] + 1 || lineLevels.length !== h[6] || xy.length !== h[7] * 2) return null;
    return {
      buffer,
      cols: h[3],
      rows: h[4],
      levels,
      lineOffsets,
      lineLevels,
      xy,
      lineCount: h[6],
      vertexCount: h[7]
    };
  } catch {
    return null;
  }
}

function emptyPacked(cols: number, rows: number): PackedHeatContours {
  return {
    buffer: new ArrayBuffer(0),
    cols,
    rows,
    levels: new Float32Array(0),
    lineOffsets: new Uint32Array([0]),
    lineLevels: new Uint32Array(0),
    xy: new Float32Array(0),
    lineCount: 0,
    vertexCount: 0
  };
}

function loadHeatContourWasm(): HeatContourWasm | null {
  if (heatContourWasm !== undefined) return heatContourWasm;
  heatContourWasm = null;
  if (typeof WebAssembly === "undefined") {
    heatContourWasmLoadError = "WebAssembly is unavailable";
    return null;
  }
  try {
    const binary = decodeBase64Bytes(HEAT_ISOLINES_WASM_BASE64);
    const module = new WebAssembly.Module(binary);
    const instance = new WebAssembly.Instance(module, {});
    const e = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      __heap_base: WebAssembly.Global;
      heat_contour_scratch_bytes: HeatContourWasm["scratchBytes"];
      heat_contour_count: HeatContourWasm["count"];
      heat_contour_build: HeatContourWasm["build"];
      heat_contour_line_count: HeatContourWasm["lineCount"];
      heat_contour_vertex_count: HeatContourWasm["vertexCount"];
      heat_contour_segment_count: HeatContourWasm["segmentCount"];
    };
    if (!(e.memory instanceof WebAssembly.Memory)) throw new Error("missing WASM memory export");
    heatContourWasm = {
      memory: e.memory,
      heapBase: Number(e.__heap_base.value),
      scratchBytes: e.heat_contour_scratch_bytes,
      count: e.heat_contour_count,
      build: e.heat_contour_build,
      lineCount: e.heat_contour_line_count,
      vertexCount: e.heat_contour_vertex_count,
      segmentCount: e.heat_contour_segment_count
    };
    return heatContourWasm;
  } catch (error) {
    heatContourWasmLoadError = error instanceof Error ? error.message : String(error);
    return null;
  }
}
