import { decodeBase64Bytes, tryGrowWasmMemory } from "./wasm-utils.js";

export interface HeatFieldKernelRequest {
  points: Float32Array;
  pointCount: number;
  cols: number;
  rows: number;
  westMerc: number;
  northMerc: number;
  widthMerc: number;
  heightMerc: number;
  kernelMerc: number;
}

export interface HeatFieldKernelResult {
  grid: Float32Array;
  peak: number;
}

export interface HeatFieldWasmProfile {
  supported?: boolean;
  inputBytes?: number;
  outputBytes?: number;
  memoryBytes?: number;
  memoryGrowMs?: number;
  inputCopyMs?: number;
  kernelMs?: number;
  snapshotMs?: number;
  totalMs?: number;
}

interface HeatFieldWasm {
  memory: WebAssembly.Memory;
  heapBase: number;
  build: (
    pointsPtr: number,
    pointCount: number,
    gridPtr: number,
    scratchPtr: number,
    cols: number,
    rows: number,
    westMerc: number,
    northMerc: number,
    widthMerc: number,
    heightMerc: number,
    kernelMerc: number
  ) => number;
}

const MAX_WASM_BYTES = 512 * 1024 * 1024;
let heatFieldWasm: HeatFieldWasm | null | undefined;
let heatFieldWasmLoadError = "";

// Generated from scripts/wasm/heat-field.rs (rustc -O, wasm32-unknown-unknown).
const HEAT_FIELD_WASM_BASE64 = "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";

export function heatFieldWasmSupported(): boolean {
  return loadHeatFieldWasm() != null;
}

export function heatFieldWasmError(): string {
  loadHeatFieldWasm();
  return heatFieldWasmLoadError;
}

export function buildHeatFieldWasm(
  request: HeatFieldKernelRequest,
  profile?: HeatFieldWasmProfile
): HeatFieldKernelResult | null {
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const started = now();
  const wasm = loadHeatFieldWasm();
  if (!wasm) {
    if (profile) profile.supported = false;
    return null;
  }

  const pointCount = Math.max(0, Math.floor(request.pointCount));
  const cols = Math.max(2, Math.floor(request.cols));
  const rows = Math.max(2, Math.floor(request.rows));
  const pointFloats = pointCount * 3;
  const cells = cols * rows;
  if (!Number.isSafeInteger(pointFloats) || !Number.isSafeInteger(cells)) return null;
  if (request.points.length < pointFloats || !validRequest(request)) return null;

  const inputBytes = pointFloats * 4;
  const outputBytes = cells * 4;
  const pointsPtr = align16(wasm.heapBase);
  const gridPtr = align16(pointsPtr + inputBytes);
  const scratchPtr = align16(gridPtr + outputBytes);
  const required = scratchPtr + outputBytes;
  if (required > MAX_WASM_BYTES || !ensureMemory(wasm.memory, required, profile, now)) return null;

  const copyStarted = now();
  new Float32Array(wasm.memory.buffer, pointsPtr, pointFloats).set(
    request.points.subarray(0, pointFloats)
  );
  if (profile) profile.inputCopyMs = now() - copyStarted;

  const kernelStarted = now();
  const peak = wasm.build(
    pointsPtr,
    pointCount,
    gridPtr,
    scratchPtr,
    cols,
    rows,
    request.westMerc,
    request.northMerc,
    request.widthMerc,
    request.heightMerc,
    request.kernelMerc
  );
  if (profile) profile.kernelMs = now() - kernelStarted;
  if (!Number.isFinite(peak) || peak < 0) return null;

  const snapshotStarted = now();
  const grid = new Float32Array(cells);
  grid.set(new Float32Array(wasm.memory.buffer, gridPtr, cells));
  if (profile) {
    profile.supported = true;
    profile.inputBytes = inputBytes;
    profile.outputBytes = outputBytes;
    profile.memoryBytes = wasm.memory.buffer.byteLength;
    profile.snapshotMs = now() - snapshotStarted;
    profile.totalMs = now() - started;
  }
  return { grid, peak };
}

function loadHeatFieldWasm(): HeatFieldWasm | null {
  if (heatFieldWasm !== undefined) return heatFieldWasm;
  try {
    if (typeof WebAssembly === "undefined") throw new Error("WebAssembly is unavailable");
    const module = new WebAssembly.Module(decodeBase64Bytes(HEAT_FIELD_WASM_BASE64));
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      __heap_base: WebAssembly.Global;
      heat_field_build: HeatFieldWasm["build"];
    };
    if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error("missing WASM memory export");
    if (typeof exports.heat_field_build !== "function") throw new Error("missing heat_field_build export");
    heatFieldWasm = {
      memory: exports.memory,
      heapBase: Number(exports.__heap_base.value),
      build: exports.heat_field_build
    };
    return heatFieldWasm;
  } catch (error) {
    heatFieldWasmLoadError = error instanceof Error ? error.message : String(error);
    heatFieldWasm = null;
    return null;
  }
}

function validRequest(request: HeatFieldKernelRequest): boolean {
  return (
    Number.isFinite(request.westMerc) &&
    Number.isFinite(request.northMerc) &&
    Number.isFinite(request.widthMerc) && request.widthMerc > 0 &&
    Number.isFinite(request.heightMerc) && request.heightMerc > 0 &&
    Number.isFinite(request.kernelMerc) && request.kernelMerc > 0
  );
}

function ensureMemory(
  memory: WebAssembly.Memory,
  requiredBytes: number,
  profile: HeatFieldWasmProfile | undefined,
  now: () => number
): boolean {
  if (requiredBytes <= memory.buffer.byteLength) return true;
  const started = now();
  const grown = tryGrowWasmMemory(memory, requiredBytes);
  if (profile) profile.memoryGrowMs = now() - started;
  return grown;
}

function align16(value: number): number {
  return (value + 15) & ~15;
}
