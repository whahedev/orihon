import type { LatLngBoundsLike } from "../geo.js";
import {
  buildHeatFieldCpu,
  createHeatFieldRequest,
  meanHeatField,
  packHeatPoints,
  unitWeightRequest,
  type HeatFieldGrid,
  type HeatFieldInput,
  type PackedHeatPoints
} from "./heat-field.js";
import { heatFieldWasmError, heatFieldWasmSupported, type HeatFieldKernelRequest } from "./heat-field-wasm.js";
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
  /**
   * `"sum"` accumulates the weights that land in a cell, so a dense area reads hotter than a
   * sparse one carrying the same values. `"mean"` divides by the mass of the same kernel, which
   * removes density from the answer: values come back in the units of the weights themselves.
   * Costs a second field pass. Default `"sum"`.
   */
  fieldModel?: "sum" | "mean";
  /**
   * Mean model only. Cells whose kernel gathered less than this fraction of the densest cell's
   * mass keep a floor under the divisor, so a lone point cannot read as a full-strength average
   * in empty space. Default 0.05.
   */
  meanSupport?: number;
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
  fieldModel: "clustered-gaussian" | "clustered-gaussian-mean";
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
  const fieldModel = options.fieldModel === "mean" ? "mean" : "sum";
  const request = createHeatFieldRequest(points, bounds, options);
  if (!request) return null;
  const threshold = Math.max(1, Math.floor(options.webgpuThreshold ?? 100_000));
  const preferred: Exclude<HeatBackend, "auto"> = requestedBackend === "auto"
    ? (mode === "heatmap" && points.count >= threshold && points.count <= 500_000 && heatFieldWebGpuAvailable() ? "webgpu" : "wasm")
    : requestedBackend;

  // Assigned by the first buildField call, which always runs before the profile is read.
  let backend: ResolvedHeatBackend = "js";
  let fallbackReason: string | undefined;
  let webgpu: HeatFieldWebGpuProfile | undefined;
  const fieldStarted = now();

  /** One field, through whichever backend was resolved, with the CPU fallback attached. */
  const buildField = async (
    kernelRequest: HeatFieldKernelRequest
  ): Promise<{ grid: Float32Array; peak: number }> => {
    if (preferred === "webgpu") {
      webgpu ??= {};
      const { buildHeatFieldWebGpu } = await import("./heat-field-webgpu.js");
      const result = await buildHeatFieldWebGpu(kernelRequest, webgpu);
      if (result) {
        backend = "webgpu";
        return result;
      }
      fallbackReason ??= webgpu.error ?? "WebGPU field build failed";
      const cpu = buildHeatFieldCpu(kernelRequest, "wasm");
      backend = cpu.backend;
      return cpu;
    }
    const wasmAvailable = heatFieldWasmSupported();
    const cpu = buildHeatFieldCpu(kernelRequest, "wasm");
    backend = cpu.backend;
    if (!wasmAvailable || cpu.backend !== "wasm") {
      fallbackReason ??= heatFieldWasmError() || "WASM field backend unavailable";
    }
    return cpu;
  };

  const summed = await buildField(request);
  // A mean field is the same kernel twice: once over the weights, once over unit weights. Doing
  // it here rather than inside each backend keeps WASM and WebGPU untouched, at the cost of a
  // second pass — which is what a density-independent scale costs.
  const mean = fieldModel === "mean"
    ? meanHeatField(summed, await buildField(unitWeightRequest(request)), options.meanSupport)
    : null;
  const fieldGrid = mean?.grid ?? summed.grid;
  const peak = mean?.peak ?? summed.peak;

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
      fieldModel: fieldModel === "mean" ? "clustered-gaussian-mean" : "clustered-gaussian",
      isolineStep: contours?.isolineStep,
      fallbackReason,
      webgpu,
      levelSelection
    }
  };
}
