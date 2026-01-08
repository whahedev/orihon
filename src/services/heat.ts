import type { LatLngBoundsLike } from "../geo.js";
import {
  buildHeatFieldCpu,
  createHeatFieldRequest,
  packHeatPoints,
  type HeatFieldGrid,
  type HeatFieldInput,
  type PackedHeatPoints
} from "./heat-field.js";
import { heatFieldWasmError, heatFieldWasmSupported } from "./heat-field-wasm.js";
import type { HeatFieldWebGpuProfile } from "./heat-field-webgpu.js";
import type { AdaptiveIsolineLevelSelection } from "./adaptive-isoline-levels.js";
import {
  buildHeatIsolinesFromField,
  type HeatIsolineBuildOptions,
  type HeatIsolineRing
} from "./heat-isolines.js";

export type HeatMode = "heatmap" | "isolines" | "both";
export type HeatBackend = "auto" | "wasm" | "webgpu";
export type HeatEvaluation = "static" | "zoom";
export type ResolvedHeatBackend = "js" | "wasm" | "webgpu";
export type HeatPoint = HeatFieldInput;
export type HeatGrid = HeatFieldGrid;
export type HeatContour = HeatIsolineRing;

export interface HeatOptions extends Omit<HeatIsolineBuildOptions, "isolineStep" | "useWasm"> {
  mode?: HeatMode;
  backend?: HeatBackend;
  /** Absolute contour interval, or `"auto"` for adaptive levels. */
  step?: "auto" | number;
  /** `auto` starts considering WebGPU at this many points. Default 100000. */
  webgpuThreshold?: number;
}

export interface HeatProfile {
  requestedBackend: HeatBackend;
  backend: ResolvedHeatBackend;
  mode: HeatMode;
  points: number;
  cols: number;
  rows: number;
  fieldMs: number;
  contoursMs: number;
  readbackMs: number;
  totalMs: number;
  /** Weighted grid aggregation + separable Gaussian KDE. */
  fieldModel: "clustered-gaussian";
  /** Actual absolute interval selected for uniformly-spaced contours. */
  isolineStep?: number;
  fallbackReason?: string;
  webgpu?: HeatFieldWebGpuProfile;
  /** Spatial diagnostics for adaptive automatic contour levels. */
  levelSelection?: AdaptiveIsolineLevelSelection;
}

export interface HeatResult {
  field: HeatGrid;
  rings: HeatContour[];
  thresholds: number[];
  levelSelection?: AdaptiveIsolineLevelSelection;
  profile: HeatProfile;
}

export interface HeatSupport {
  wasm: boolean;
  webgpu: boolean;
}

/** Report the accelerated backends available in the current runtime. */
export async function heatSupport(): Promise<HeatSupport> {
  return {
    wasm: heatFieldWasmSupported(),
    webgpu: await heatFieldWebGpuSupported()
  };
}

export function heatFieldWebGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as unknown as { gpu?: unknown }).gpu);
}

export async function heatFieldWebGpuSupported(): Promise<boolean> {
  if (!heatFieldWebGpuAvailable()) return false;
  return (await import("./heat-field-webgpu.js")).heatFieldWebGpuSupported();
}

export async function buildHeat(
  points: Iterable<HeatPoint>,
  bounds: LatLngBoundsLike,
  options: HeatOptions = {}
): Promise<HeatResult | null> {
  return buildPackedHeat(packHeatPoints(points), bounds, options);
}

export async function buildPackedHeat(
  points: PackedHeatPoints,
  bounds: LatLngBoundsLike,
  options: HeatOptions = {}
): Promise<HeatResult | null> {
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const started = now();
  const mode = options.mode ?? "heatmap";
  const requestedBackend = options.backend ?? "auto";
  const request = createHeatFieldRequest(points, bounds, options);
  if (!request) return null;
  const threshold = Math.max(1, Math.floor(options.webgpuThreshold ?? 100_000));
  const preferred: Exclude<HeatBackend, "auto"> = requestedBackend === "auto"
    ? (mode === "heatmap" && points.count >= threshold && points.count <= 500_000 && heatFieldWebGpuAvailable() ? "webgpu" : "wasm")
    : requestedBackend;

  let backend: ResolvedHeatBackend;
  let fieldGrid: Float32Array;
  let peak: number;
  let fallbackReason: string | undefined;
  let webgpu: HeatFieldWebGpuProfile | undefined;
  const fieldStarted = now();

  if (preferred === "webgpu") {
    webgpu = {};
    const { buildHeatFieldWebGpu } = await import("./heat-field-webgpu.js");
    const result = await buildHeatFieldWebGpu(request, webgpu);
    if (result) {
      backend = "webgpu";
      fieldGrid = result.grid;
      peak = result.peak;
    } else {
      fallbackReason = webgpu.error ?? "WebGPU field build failed";
      const cpu = buildHeatFieldCpu(request, "wasm");
      backend = cpu.backend;
      fieldGrid = cpu.grid;
      peak = cpu.peak;
    }
  } else {
    const wasmAvailable = heatFieldWasmSupported();
    const cpu = buildHeatFieldCpu(request, "wasm");
    backend = cpu.backend;
    fieldGrid = cpu.grid;
    peak = cpu.peak;
    if (!wasmAvailable || cpu.backend !== "wasm") {
      fallbackReason = heatFieldWasmError() || "WASM field backend unavailable";
    }
  }

  const field: HeatGrid = {
    grid: fieldGrid,
    cols: request.cols,
    rows: request.rows,
    peak,
    westMerc: request.westMerc,
    northMerc: request.northMerc,
    widthMerc: request.widthMerc,
    heightMerc: request.heightMerc,
    kernelMerc: request.kernelMerc
  };
  const fieldMs = now() - fieldStarted;
  const contoursStarted = now();
  const numericStep = Number(options.step);
  const contourOptions: HeatIsolineBuildOptions = {
    ...options,
    isolineStep: options.step,
    useWasm: true
  };
  const adaptive = mode !== "heatmap" && options.adaptiveLevels !== false &&
    !Array.isArray(options.levels) && !(Number.isFinite(numericStep) && numericStep > 0);
  const contours = mode === "heatmap"
    ? null
    : adaptive
      ? (await import("./adaptive-isoline-levels.js")).buildAdaptiveIsolinesFromField(field, contourOptions)
      : buildHeatIsolinesFromField(field, contourOptions);
  const rings = contours?.rings ?? [];
  const levelSelection = contours?.levelSelection;
  const thresholds = contours?.thresholds ?? [];
  const contoursMs = now() - contoursStarted;
  return {
    field,
    rings,
    thresholds,
    levelSelection,
    profile: {
      requestedBackend,
      backend,
      mode,
      points: points.count,
      cols: request.cols,
      rows: request.rows,
      fieldMs,
      contoursMs,
      readbackMs: webgpu?.readbackMs ?? 0,
      totalMs: now() - started,
      fieldModel: "clustered-gaussian",
      isolineStep: contours?.isolineStep,
      fallbackReason,
      webgpu,
      levelSelection
    }
  };
}
