import {
  TILE_SIZE,
  unproject,
  type LatLngBoundsLike,
} from "../geo.js";
import {
  buildHeatContoursWasm,
  type HeatContoursWasmProfile,
  type PackedHeatContours
} from "./heat-isolines-wasm.js";
import {
  buildHeatFieldCpu,
  createHeatFieldRequest,
  packHeatPoints,
  type HeatFieldCpuResult,
  type HeatFieldGrid,
  type HeatFieldInput
} from "./heat-field.js";
import type { AdaptiveIsolineLevelSelection } from "./adaptive-isoline-levels.js";

export {
  buildHeatContoursWasm,
  buildHeatContoursWasmUnsafe,
  decodeHeatContoursWasmBlob,
  heatContoursWasmError,
  heatContoursWasmSupported,
  type HeatContoursWasmProfile,
  type PackedHeatContours
} from "./heat-isolines-wasm.js";

export type HeatIsolineInput = HeatFieldInput;
export type { HeatFieldGrid } from "./heat-field.js";

export interface HeatIsolineBuildOptions {
  /** Grid columns (default 96). */
  cols?: number;
  /** Grid rows (default 72). */
  rows?: number;
  /** Geographic kernel radius expressed as CSS px at `scaleZoom`. Default 28. */
  radius?: number;
  blur?: number;
  /** Fixed reference zoom that defines the world-space kernel. */
  scaleZoom?: number;
  /** Current map zoom. It changes sampling density, never the world-space kernel. */
  zoom?: number;
  /**
   * Contour levels. Values <=1 are fractions of `referenceMax` when supplied,
   * otherwise fractions of the current grid peak for backwards compatibility.
   * Values >1 are absolute field values.
   */
  levels?: number | number[];
  /** Absolute difference between adjacent contour values. Default `"auto"`. */
  isolineStep?: "auto" | number;
  /** Safety cap for automatically/manual-step generated levels. Default 32. */
  maxIsolineLevels?: number;
  /** Spatially optimize automatic levels. Unified async pipeline default: true. */
  adaptiveLevels?: boolean;
  /** Valid cells; zero cells and NoData are excluded from selection and marching. */
  validMask?: ArrayLike<number> | null;
  /** Robust automatic value range. Default `[0.02, 0.98]`. */
  outlierQuantiles?: [number, number];
  /** Automatic candidate count multiplier, constrained to 5..20. Default 10. */
  candidateMultiplier?: number;
  /** Spatial coverage influence radius in evaluation-zone cells. */
  coverageRadius?: number;
  /** Candidate preview must cross at least this many field cells. */
  minCandidateCells?: number;
  /** Remove final lines shorter than this many grid-cell units. */
  minIsolineLength?: number;
  /** Remove final closed rings smaller than this many grid-cell² units. */
  minIsolineArea?: number;
  coverageWeight?: number;
  rangeWeight?: number;
  redundancyWeight?: number;
  fragmentWeight?: number;
  /**
   * Fixed field maximum used for color/level normalization across zooms.
   * Set this for zoom-invariant value semantics (for normalized sensor values use 1).
   */
  referenceMax?: number;
  /** Skip rebuilding if max density is below this. Default 1e-6. */
  minPeak?: number;
  /** Whole-grid WASM marching+stitching. Default true; falls back to JS on failure. */
  useWasm?: boolean;
  /** Internal A/B hook. */
  __forceJsContours?: boolean;
  /** Internal benchmark/profile hook. */
  __heatContoursWasmProfile?: HeatContoursWasmProfile;
}

export interface HeatIsolineRing {
  /** Stable index within the selected level array. */
  levelId?: number;
  /** Contour threshold in absolute field units. */
  value: number;
  /** Normalized 0..1 vs `referenceMax` (or local peak when not supplied). */
  t: number;
  /** Closed or open rings as [lat, lng][]. */
  coordinates: Array<[number, number]>;
  /** Length in scalar-grid cell units. */
  gridLength?: number;
  /** Closed area in scalar-grid cell² units; zero for open lines. */
  gridArea?: number;
  /** Marginal spatial coverage contributed by this adaptive level. */
  gain?: number;
}

export interface HeatIsolineResult {
  cols: number;
  rows: number;
  peak: number;
  rings: HeatIsolineRing[];
  /** Actual absolute contour thresholds used for this field. */
  thresholds?: number[];
  /** Uniform threshold step, when the selected levels are evenly spaced. */
  isolineStep?: number;
  /** True when marching+stitching was produced by the whole-grid WASM kernel. */
  wasm?: boolean;
  /** Scalar-field backend. Contours still use WASM whenever available. */
  fieldBackend?: "js" | "wasm" | "webgpu";
  /** Spatial level-selection diagnostics when adaptive auto mode was used. */
  levelSelection?: AdaptiveIsolineLevelSelection;
}

/**
 * Build a zoom-invariant world-space heat field and extract isolines.
 * The kernel is fixed in normalized Web Mercator by `radius@scaleZoom`; zoom only
 * changes how densely that same mathematical field is sampled on screen.
 */
export function buildHeatIsolines(
  points: Iterable<HeatIsolineInput>,
  boundsLike: LatLngBoundsLike,
  options: HeatIsolineBuildOptions = {}
): HeatIsolineResult {
  const field = buildHeatFieldGrid(points, boundsLike, options);
  if (!field) return { cols: 0, rows: 0, peak: 0, rings: [] };

  return buildHeatIsolinesFromField(field, options);
}

/** Extract contours from an already-built field. `both` mode uses this path. */
export function buildHeatIsolinesFromField(
  field: HeatFieldGrid,
  options: HeatIsolineBuildOptions = {}
): HeatIsolineResult {

  const { grid, cols, rows, peak } = field;
  const fieldBackend = (field as HeatFieldCpuResult).backend;
  const minPeak = options.minPeak ?? 1e-6;
  if (peak < minPeak) return { cols, rows, peak, rings: [], fieldBackend };

  const referenceMax = finitePositive(options.referenceMax) ? Number(options.referenceMax) : peak;
  const resolved = resolveLevels(options.levels, options.isolineStep, peak, referenceMax, options.maxIsolineLevels);
  const thresholds = resolved.thresholds;
  if (!thresholds.length) {
    return { cols, rows, peak, rings: [], thresholds, isolineStep: resolved.step, fieldBackend };
  }

  if (options.useWasm !== false && !options.__forceJsContours && !options.validMask) {
    const packed = buildHeatContoursWasm(
      grid,
      cols,
      rows,
      Float32Array.from(thresholds),
      options.__heatContoursWasmProfile
    );
    if (packed) {
      return {
        cols,
        rows,
        peak,
        rings: materializePackedContours(packed, field, referenceMax),
        thresholds,
        isolineStep: resolved.step,
        wasm: true,
        fieldBackend
      };
    }
  }

  const rings: HeatIsolineRing[] = [];
  for (const value of thresholds) {
    const segments = marchingSquaresSegments(grid, cols, rows, value, options.validMask);
    const chains = connectSegments(segments);
    for (const chain of chains) {
      if (chain.length < 2) continue;
      rings.push({
        value,
        t: clamp01(value / referenceMax),
        coordinates: chain.map(([gx, gy]) => gridPointToLatLng(gx, gy, field))
      });
    }
  }
  return { cols, rows, peak, rings, thresholds, isolineStep: resolved.step, wasm: false, fieldBackend };
}

/**
 * Scalar field only. Exported so benchmarks/tools can separate field construction
 * from marching/stitching. No viewport-local normalization is applied.
 */
export function buildHeatFieldGrid(
  points: Iterable<HeatIsolineInput>,
  boundsLike: LatLngBoundsLike,
  options: HeatIsolineBuildOptions = {}
): HeatFieldGrid | null {
  const packed = packHeatPoints(points);
  const request = createHeatFieldRequest(packed, boundsLike, options);
  if (!request) return null;
  return buildHeatFieldCpu(request, options.useWasm === false ? "js" : "wasm");
}

function materializePackedContours(
  packed: PackedHeatContours,
  field: HeatFieldGrid,
  referenceMax: number
): HeatIsolineRing[] {
  const rings = new Array<HeatIsolineRing>(packed.lineCount);
  for (let line = 0; line < packed.lineCount; line++) {
    const start = packed.lineOffsets[line];
    const end = packed.lineOffsets[line + 1];
    const levelIndex = packed.lineLevels[line];
    const value = packed.levels[levelIndex] ?? 0;
    const coordinates = new Array<[number, number]>(Math.max(0, end - start));
    for (let i = start, w = 0; i < end; i++, w++) {
      coordinates[w] = gridPointToLatLng(packed.xy[i * 2], packed.xy[i * 2 + 1], field);
    }
    rings[line] = { value, t: clamp01(value / referenceMax), coordinates };
  }
  return rings;
}

function gridPointToLatLng(gx: number, gy: number, field: HeatFieldGrid): [number, number] {
  const mx = field.westMerc + (gx / Math.max(field.cols - 1, 1)) * field.widthMerc;
  const my = field.northMerc + (gy / Math.max(field.rows - 1, 1)) * field.heightMerc;
  const ll = unproject([mx * TILE_SIZE, my * TILE_SIZE], 0);
  return [ll.lat, ll.lng];
}

function resolveLevels(
  levels: number | number[] | undefined,
  requestedStep: "auto" | number | undefined,
  peak: number,
  referenceMax: number,
  maxLevels: number | undefined
): { thresholds: number[]; step?: number } {
  const cap = Math.max(referenceMax, 1e-12);
  if (Array.isArray(levels) && levels.length) {
    return { thresholds: levels
      .map((v) => (v > 1 ? v : v * cap))
      .filter((v) => Number.isFinite(v) && v > 0 && v < peak * 0.999999)
      .sort((a, b) => a - b) };
  }
  const limit = Math.max(1, Math.min(128, Math.floor(maxLevels ?? 32)));
  const count = Math.max(1, Math.min(limit, Math.floor(typeof levels === "number" ? levels : 5)));
  const numericStep = Number(requestedStep);
  const step = Number.isFinite(numericStep) && numericStep > 0
    ? numericStep
    : niceIsolineStep(cap / (count + 1));
  const thresholds: number[] = [];
  for (let value = step; value < peak * 0.999999 && thresholds.length < limit; value += step) {
    thresholds.push(value);
  }
  return { thresholds, step };
}

/** 1–2–2.5–5 engineering steps keep automatic legends stable and readable. */
function niceIsolineStep(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const fraction = value / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** Marching-squares edge segments in grid coordinates (JS fallback/reference). */
function marchingSquaresSegments(
  grid: Float32Array,
  cols: number,
  rows: number,
  threshold: number,
  validMask?: ArrayLike<number> | null
): Array<[[number, number], [number, number]]> {
  const out: Array<[[number, number], [number, number]]> = [];
  const lerp = (a: number, b: number, va: number, vb: number): number => {
    const d = vb - va;
    if (Math.abs(d) < 1e-12) return (a + b) * 0.5;
    return a + ((threshold - va) / d) * (b - a);
  };

  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const i = y * cols + x;
      if (validMask && (!(Number(validMask[i]) > 0) || !(Number(validMask[i + 1]) > 0) ||
        !(Number(validMask[i + cols]) > 0) || !(Number(validMask[i + cols + 1]) > 0))) continue;
      const tl = grid[i];
      const tr = grid[i + 1];
      const br = grid[i + cols + 1];
      const bl = grid[i + cols];
      const code =
        (tl >= threshold ? 8 : 0) |
        (tr >= threshold ? 4 : 0) |
        (br >= threshold ? 2 : 0) |
        (bl >= threshold ? 1 : 0);
      if (code === 0 || code === 15) continue;

      const top: [number, number] = [lerp(x, x + 1, tl, tr), y];
      const right: [number, number] = [x + 1, lerp(y, y + 1, tr, br)];
      const bottom: [number, number] = [lerp(x, x + 1, bl, br), y + 1];
      const left: [number, number] = [x, lerp(y, y + 1, tl, bl)];

      switch (code) {
        case 1:
        case 14:
          out.push([left, bottom]);
          break;
        case 2:
        case 13:
          out.push([bottom, right]);
          break;
        case 3:
        case 12:
          out.push([left, right]);
          break;
        case 4:
        case 11:
          out.push([top, right]);
          break;
        case 5: {
          const avg = (tl + tr + br + bl) * 0.25;
          if (avg >= threshold) out.push([left, top], [bottom, right]);
          else out.push([left, bottom], [top, right]);
          break;
        }
        case 6:
        case 9:
          out.push([top, bottom]);
          break;
        case 7:
        case 8:
          out.push([left, top]);
          break;
        case 10: {
          const avg = (tl + tr + br + bl) * 0.25;
          if (avg >= threshold) out.push([left, bottom], [top, right]);
          else out.push([left, top], [bottom, right]);
          break;
        }
        default:
          break;
      }
    }
  }
  return out;
}


function connectSegments(
  segments: Array<[[number, number], [number, number]]>
): Array<Array<[number, number]>> {
  if (!segments.length) return [];
  const key = (p: [number, number]): string => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const used = new Uint8Array(segments.length);
  const chains: Array<Array<[number, number]>> = [];
  const ends = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i];
    const ka = key(a);
    const kb = key(b);
    let la = ends.get(ka);
    if (!la) { la = []; ends.set(ka, la); }
    la.push(i);
    let lb = ends.get(kb);
    if (!lb) { lb = []; ends.set(kb, lb); }
    lb.push(i);
  }

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const [a0, b0] = segments[start];
    const chain: Array<[number, number]> = [a0, b0];
    let head = b0;
    for (;;) {
      const candidates = ends.get(key(head));
      if (!candidates) break;
      let nextIdx = -1;
      for (const idx of candidates) if (!used[idx]) { nextIdx = idx; break; }
      if (nextIdx < 0) break;
      used[nextIdx] = 1;
      const [a, b] = segments[nextIdx];
      if (key(a) === key(head)) { chain.push(b); head = b; }
      else { chain.push(a); head = a; }
    }
    let tail = a0;
    for (;;) {
      const candidates = ends.get(key(tail));
      if (!candidates) break;
      let nextIdx = -1;
      for (const idx of candidates) if (!used[idx]) { nextIdx = idx; break; }
      if (nextIdx < 0) break;
      used[nextIdx] = 1;
      const [a, b] = segments[nextIdx];
      if (key(a) === key(tail)) { chain.unshift(b); tail = b; }
      else { chain.unshift(a); tail = a; }
    }
    chains.push(chain);
  }
  return chains;
}

function finitePositive(value: unknown): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
