import { TILE_SIZE, latLng, bounds, projectMercator01, unproject, type LatLngBoundsLike, type LatLngLike } from "../geo.js";
import {
  buildHeatFieldWasm,
  type HeatFieldKernelRequest,
  type HeatFieldWasmProfile
} from "./heat-field-wasm.js";
import {
  isAsyncIterable,
  resolveAsyncBatchOptions,
  throwIfAsyncAborted,
  yieldAsyncBatch,
  type AsyncBatchOptions
} from "./async-batch.js";

export type HeatFieldInput = LatLngLike | [number, number, number?];

export interface HeatFieldOptions {
  cols?: number;
  rows?: number;
  radius?: number;
  blur?: number;
  scaleZoom?: number;
  zoom?: number;
}

export interface HeatFieldGrid {
  grid: Float32Array;
  cols: number;
  rows: number;
  peak: number;
  westMerc: number;
  northMerc: number;
  widthMerc: number;
  heightMerc: number;
  kernelMerc: number;
}

export interface PackedHeatPoints {
  data: Float32Array;
  count: number;
  /** Full source extent in normalized Web Mercator. Kept with the packed snapshot. */
  bounds?: PackedHeatBounds;
}

export interface PackedHeatBounds {
  westMerc: number;
  northMerc: number;
  eastMerc: number;
  southMerc: number;
}

export interface HeatFieldAsyncDataOptions extends AsyncBatchOptions {}

export type HeatFieldCpuBackend = "js" | "wasm";
const MAX_HEAT_GRID_DIMENSION = 4096;
const MAX_HEAT_WEIGHT = 1_000_000;

export interface HeatFieldCpuResult extends HeatFieldGrid {
  backend: HeatFieldCpuBackend;
  profile?: HeatFieldWasmProfile;
}

export function packHeatPoints(points: Iterable<HeatFieldInput>): PackedHeatPoints {
  const values: number[] = [];
  let count = 0;
  const bounds = emptyPackedBounds();
  for (const raw of points) {
    const point = normalizeHeat(raw);
    if (!point || point.weight <= 0) continue;
    const merc = projectMercator01(point.lat, point.lng);
    values.push(merc.x, merc.y, Math.min(MAX_HEAT_WEIGHT, point.weight));
    extendPackedBounds(bounds, merc.x, merc.y);
    count++;
  }
  return { data: Float32Array.from(values), count, bounds: finalizePackedBounds(bounds) };
}

/** Cooperatively project and pack a large heat source, then return one atomic snapshot. */
export async function packHeatPointsAsync(
  points: Iterable<HeatFieldInput> | AsyncIterable<HeatFieldInput>,
  options: HeatFieldAsyncDataOptions = {}
): Promise<PackedHeatPoints> {
  const resolved = resolveAsyncBatchOptions(options, 50_000);
  const total = Array.isArray(points) ? points.length : null;
  let buffer = total == null ? null : new Float32Array(total * 3);
  const values: number[] = [];
  let processed = 0;
  let write = 0;
  const bounds = emptyPackedBounds();
  throwIfAsyncAborted(resolved.signal);

  const append = (raw: HeatFieldInput): void => {
    const point = normalizeHeat(raw);
    if (!point || point.weight <= 0) return;
    const merc = projectMercator01(point.lat, point.lng);
    const weight = Math.min(MAX_HEAT_WEIGHT, point.weight);
    if (buffer) {
      buffer[write] = merc.x;
      buffer[write + 1] = merc.y;
      buffer[write + 2] = weight;
    } else {
      values.push(merc.x, merc.y, weight);
    }
    extendPackedBounds(bounds, merc.x, merc.y);
    write += 3;
  };
  const checkpoint = async (final: boolean): Promise<void> => {
    resolved.onProgress?.(processed, total);
    if (!final) await yieldAsyncBatch(resolved.yieldMode);
    throwIfAsyncAborted(resolved.signal);
  };

  if (Array.isArray(points)) {
    for (let index = 0; index < points.length; index++) {
      append(points[index]);
      processed++;
      if (processed % resolved.chunkSize === 0) await checkpoint(index === points.length - 1);
    }
  } else if (isAsyncIterable<HeatFieldInput>(points)) {
    for await (const point of points) {
      append(point);
      processed++;
      if (processed % resolved.chunkSize === 0) await checkpoint(false);
    }
  } else {
    for (const point of points) {
      append(point);
      processed++;
      if (processed % resolved.chunkSize === 0) await checkpoint(false);
    }
  }
  if (processed % resolved.chunkSize !== 0) await checkpoint(true);

  if (!buffer) buffer = Float32Array.from(values);
  else if (write !== buffer.length) buffer = buffer.slice(0, write);
  return { data: buffer, count: write / 3, bounds: finalizePackedBounds(bounds) };
}

/** Convert ObjectManager's compact Float64 `[mercX, mercY]` pack without LatLng objects. */
export function packHeatMercator(
  mercator: Float64Array | Float32Array,
  pointCount: number,
  weights?: ArrayLike<number> | null
): PackedHeatPoints {
  const count = Math.max(0, Math.min(Math.floor(pointCount), Math.floor(mercator.length / 2)));
  const data = new Float32Array(count * 3);
  let write = 0;
  const bounds = emptyPackedBounds();
  for (let i = 0; i < count; i++) {
    const mx = Number(mercator[i * 2]);
    const my = Number(mercator[i * 2 + 1]);
    const weight = weights ? Number(weights[i]) : 1;
    if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(weight) || weight <= 0) continue;
    data[write++] = mx;
    data[write++] = my;
    data[write++] = Math.min(MAX_HEAT_WEIGHT, weight);
    extendPackedBounds(bounds, mx, my);
  }
  return { data: data.subarray(0, write), count: write / 3, bounds: finalizePackedBounds(bounds) };
}

/** Full packed source domain, padded in Mercator units and converted to LatLng bounds. */
export function packedHeatLatLngBounds(
  points: PackedHeatPoints,
  paddingMerc = 0
): LatLngBoundsLike | null {
  const bounds = points.bounds ?? scanPackedBounds(points);
  if (!bounds) return null;
  const padding = Math.max(0, Number.isFinite(paddingMerc) ? paddingMerc : 0);
  const west = Math.max(0, bounds.westMerc - padding);
  const east = Math.min(1, bounds.eastMerc + padding);
  const north = Math.max(0, bounds.northMerc - padding);
  const south = Math.min(1, bounds.southMerc + padding);
  const nw = unproject([west * TILE_SIZE, north * TILE_SIZE], 0);
  const se = unproject([east * TILE_SIZE, south * TILE_SIZE], 0);
  return { south: se.lat, west: nw.lng, north: nw.lat, east: se.lng };
}

export function createHeatFieldRequest(
  points: PackedHeatPoints,
  boundsLike: LatLngBoundsLike,
  options: HeatFieldOptions = {}
): HeatFieldKernelRequest | null {
  const area = bounds(boundsLike);
  if (!area.isValid()) return null;
  const cols = gridDimension(options.cols, 96);
  const rows = gridDimension(options.rows, 72);
  const zoom = finiteNumber(options.zoom, finiteNumber(options.scaleZoom, 10));
  const scaleZoom = Math.max(-24, Math.min(30, finiteNumber(options.scaleZoom, zoom)));
  // Blur is the soft halo outside the solid radius in the established canvas
  // heatmap model. Counting only 35% made the world-space field too compact.
  const baseRadiusCss = Math.max(4, (options.radius ?? 28) + (options.blur ?? 16));
  const kernelMerc = baseRadiusCss / (TILE_SIZE * 2 ** scaleZoom);
  const westMerc = projectMercator01(0, area.west).x;
  const eastMerc = projectMercator01(0, area.east).x;
  const northMerc = projectMercator01(area.north, 0).y;
  const southMerc = projectMercator01(area.south, 0).y;
  return {
    points: points.data,
    pointCount: points.count,
    cols,
    rows,
    westMerc,
    northMerc,
    widthMerc: Math.max(1e-12, eastMerc - westMerc),
    heightMerc: Math.max(1e-12, southMerc - northMerc),
    kernelMerc
  };
}

export function buildHeatFieldCpu(
  request: HeatFieldKernelRequest,
  backend: HeatFieldCpuBackend = "wasm"
): HeatFieldCpuResult {
  if (backend === "wasm") {
    const profile: HeatFieldWasmProfile = {};
    const result = buildHeatFieldWasm(request, profile);
    if (result) return { ...requestMetadata(request), ...result, backend: "wasm", profile };
  }
  const result = buildHeatFieldJs(request);
  return { ...requestMetadata(request), ...result, backend: "js" };
}

/**
 * The same request with every weight replaced by 1. Applying the kernel to it gives the mass
 * each cell drew from — the denominator of a mean field.
 */
export function unitWeightRequest(request: HeatFieldKernelRequest): HeatFieldKernelRequest {
  const end = Math.min(request.points.length, request.pointCount * 3);
  const points = new Float32Array(end);
  for (let i = 0; i < end; i += 3) {
    points[i] = request.points[i];
    points[i + 1] = request.points[i + 1];
    points[i + 2] = request.points[i + 2] > 0 ? 1 : 0;
  }
  return { ...request, points, pointCount: Math.floor(end / 3) };
}

/**
 * Divide a summed field by the mass of the same kernel, turning "how much weight landed here"
 * into "what the weights here average". A summed field cannot tell a hot sparse area from a warm
 * dense one; a mean field can, and its values are in the units of the weights themselves, so a
 * reference maximum is whatever a single point can carry rather than a measured density.
 *
 * `support` guards the sparse tail: where the kernel gathered almost nothing, the quotient is
 * decided by one or two points and would read as a full-strength average in the middle of empty
 * space. Cells below that fraction of the densest cell keep a floor under the divisor, so they
 * fade out instead of flaring up.
 */
export function meanHeatField(
  sum: { grid: Float32Array; peak: number },
  mass: { grid: Float32Array; peak: number },
  support = 0.05
): { grid: Float32Array; peak: number } {
  const floor = Math.max(mass.peak * clampSupport(support), 1e-12);
  const grid = new Float32Array(sum.grid.length);
  let peak = 0;
  for (let i = 0; i < grid.length; i++) {
    const divisor = Math.max(mass.grid[i], floor);
    const value = sum.grid[i] / divisor;
    grid[i] = value;
    if (value > peak) peak = value;
  }
  return { grid, peak };
}

function clampSupport(support: number): number {
  if (!Number.isFinite(support)) return 0.05;
  return Math.max(1e-6, Math.min(1, support));
}

/** Reference implementation; kept for parity tests and environments without WASM. */
export function buildHeatFieldJs(request: HeatFieldKernelRequest): { grid: Float32Array; peak: number } {
  const { cols, rows, westMerc, northMerc, widthMerc, heightMerc, kernelMerc } = request;
  const grid = new Float32Array(cols * rows);
  const scratch = new Float32Array(cols * rows);
  const cellMercX = widthMerc / Math.max(cols - 1, 1);
  const cellMercY = heightMerc / Math.max(rows - 1, 1);
  const radiusCellsX = Math.max(0.51, kernelMerc / cellMercX);
  const radiusCellsY = Math.max(0.51, kernelMerc / cellMercY);
  const rCeilX = Math.ceil(radiusCellsX);
  const rCeilY = Math.ceil(radiusCellsY);
  const end = Math.min(request.points.length, request.pointCount * 3);

  // Stage 1: a weighted spatial grid. Bilinear deposition preserves a cluster's
  // sub-cell centroid instead of snapping every source to one raster pixel.
  for (let i = 0; i < end; i += 3) {
    const mx = request.points[i];
    const my = request.points[i + 1];
    const weight = request.points[i + 2];
    if (weight <= 0) continue;
    const fx = ((mx - westMerc) / widthMerc) * (cols - 1);
    const fy = ((my - northMerc) / heightMerc) * (rows - 1);
    if (fx < 0 || fy < 0 || fx > cols - 1 || fy > rows - 1) continue;
    const x0 = Math.min(cols - 1, Math.max(0, Math.floor(fx)));
    const y0 = Math.min(rows - 1, Math.max(0, Math.floor(fy)));
    const x1 = Math.min(cols - 1, x0 + 1);
    const y1 = Math.min(rows - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    grid[y0 * cols + x0] += weight * (1 - tx) * (1 - ty);
    grid[y0 * cols + x1] += weight * tx * (1 - ty);
    grid[y1 * cols + x0] += weight * (1 - tx) * ty;
    grid[y1 * cols + x1] += weight * tx * ty;
  }

  // Stage 2: a separable Gaussian KDE. It is mathematically the same 2D
  // Gaussian as a point splat, but costs O(grid × radius), independent of N.
  const kernelX = gaussianKernel(rCeilX, radiusCellsX);
  const kernelY = gaussianKernel(rCeilY, radiusCellsY);
  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    for (let x = 0; x < cols; x++) {
      let value = 0;
      const from = Math.max(0, x - rCeilX);
      const to = Math.min(cols - 1, x + rCeilX);
      for (let sx = from; sx <= to; sx++) value += grid[row + sx] * kernelX[Math.abs(sx - x)];
      scratch[row + x] = value;
    }
  }
  let peak = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let value = 0;
      const from = Math.max(0, y - rCeilY);
      const to = Math.min(rows - 1, y + rCeilY);
      for (let sy = from; sy <= to; sy++) value += scratch[sy * cols + x] * kernelY[Math.abs(sy - y)];
      grid[y * cols + x] = value;
      peak = Math.max(peak, value);
    }
  }
  return { grid, peak };
}

function gaussianKernel(radius: number, scale: number): Float32Array {
  const kernel = new Float32Array(radius + 1);
  for (let i = 0; i <= radius; i++) {
    const d = i / Math.max(scale, 1e-6);
    kernel[i] = Math.exp(-4 * d * d);
  }
  return kernel;
}

function requestMetadata(request: HeatFieldKernelRequest): Omit<HeatFieldGrid, "grid" | "peak"> {
  return {
    cols: request.cols,
    rows: request.rows,
    westMerc: request.westMerc,
    northMerc: request.northMerc,
    widthMerc: request.widthMerc,
    heightMerc: request.heightMerc,
    kernelMerc: request.kernelMerc
  };
}

function normalizeHeat(value: HeatFieldInput): { lat: number; lng: number; weight: number } | null {
  if (Array.isArray(value)) {
    const lat = Number(value[0]);
    const lng = Number(value[1]);
    const weight = value[2] == null ? 1 : Number(value[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, weight: Number.isFinite(weight) ? weight : 1 };
  }
  const point = latLng(value);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return { lat: point.lat, lng: point.lng, weight: 1 };
}

function gridDimension(value: number | undefined, fallback: number): number {
  const numeric = Number(value);
  return Math.max(8, Math.min(MAX_HEAT_GRID_DIMENSION, Math.floor(Number.isFinite(numeric) ? numeric : fallback)));
}

function finiteNumber(value: number | undefined, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function emptyPackedBounds(): PackedHeatBounds {
  return { westMerc: Infinity, northMerc: Infinity, eastMerc: -Infinity, southMerc: -Infinity };
}

function extendPackedBounds(bounds: PackedHeatBounds, x: number, y: number): void {
  bounds.westMerc = Math.min(bounds.westMerc, x);
  bounds.eastMerc = Math.max(bounds.eastMerc, x);
  bounds.northMerc = Math.min(bounds.northMerc, y);
  bounds.southMerc = Math.max(bounds.southMerc, y);
}

function finalizePackedBounds(bounds: PackedHeatBounds): PackedHeatBounds | undefined {
  return Number.isFinite(bounds.westMerc) && Number.isFinite(bounds.northMerc) &&
    Number.isFinite(bounds.eastMerc) && Number.isFinite(bounds.southMerc)
    ? bounds
    : undefined;
}

function scanPackedBounds(points: PackedHeatPoints): PackedHeatBounds | undefined {
  const bounds = emptyPackedBounds();
  const end = Math.min(points.data.length, Math.max(0, Math.floor(points.count)) * 3);
  for (let i = 0; i < end; i += 3) {
    const x = points.data[i];
    const y = points.data[i + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) extendPackedBounds(bounds, x, y);
  }
  return finalizePackedBounds(bounds);
}
