export interface AdaptiveIsolineLevelOptions {
  levels?: number;
  validMask?: ArrayLike<number> | null;
  /** Robust value range. Default `[0.02, 0.98]`. */
  outlierQuantiles?: [number, number];
  /** Candidate pool size as a multiple of requested levels. Default 10, range 5..20. */
  candidateMultiplier?: number;
  /** Coverage influence radius in evaluation-zone cells. Default 1. */
  coverageRadius?: number;
  /** Reject candidate contours crossing fewer cells than this. Default 4. */
  minCandidateCells?: number;
  coverageWeight?: number;
  rangeWeight?: number;
  redundancyWeight?: number;
  fragmentWeight?: number;
}

export interface AdaptiveIsolineLevelMetric {
  level: number;
  gain: number;
  coverage: number;
  redundancy: number;
  lengthCells: number;
  fragmentation: number;
}

export interface AdaptiveIsolineLevelSelection {
  thresholds: number[];
  selected: AdaptiveIsolineLevelMetric[];
  range: [number, number];
  coverage: number;
  uniformCoverage: number;
  redundancy: number;
  /** Variance of selected-line density across valid evaluation zones. */
  distributionVariance: number;
  /** Mean fraction of isolated/noisy preview fragments. */
  noiseFraction: number;
  /** Integrated coverage/range/redundancy/noise/uniformity score. */
  score: number;
  validZones: number;
  candidateCount: number;
}

interface Candidate {
  level: number;
  t: number;
  bits: Uint32Array;
  covered: number;
  length: number;
  fragmentation: number;
}

/** Lazy unified-pipeline entry: select levels, build WASM contours, enrich/filter output. */
export function buildAdaptiveIsolinesFromField(
  field: HeatFieldGrid,
  options: HeatIsolineBuildOptions = {}
): HeatIsolineResult {
  const selection = selectAdaptiveIsolineLevels(field.grid, field.cols, field.rows, {
    ...options,
    levels: typeof options.levels === "number" ? options.levels : 5
  });
  const resolved = selection.thresholds.length ? { ...options, levels: selection.thresholds } : options;
  const result = buildHeatIsolinesFromField(field, { ...resolved, useWasm: options.useWasm !== false });
  result.levelSelection = selection;
  const minLength = Math.max(0, Number(options.minIsolineLength) || 0);
  const minArea = Math.max(0, Number(options.minIsolineArea) || 0);
  for (const ring of result.rings) {
    const levelId = nearestLevel(result.thresholds ?? [], ring.value);
    const metric = selection.selected.find((item) =>
      Math.abs(item.level - ring.value) <= Math.max(1e-7, Math.abs(ring.value) * 1e-6));
    const geometry = ringMetrics(ring, field);
    ring.levelId = levelId;
    ring.gridLength = geometry.length;
    ring.gridArea = geometry.area;
    ring.gain = metric?.gain;
  }
  if (minLength || minArea) result.rings = result.rings.filter((ring) =>
    (ring.gridLength ?? 0) >= minLength && (!(ring.gridArea) || ring.gridArea >= minArea));
  return result;
}

/**
 * Select contour values by spatial utility rather than equal numeric spacing.
 * Preview geometry is evaluated in a compact zoning grid; final geometry is
 * still produced by the WASM marching/stitching kernel.
 */
export function selectAdaptiveIsolineLevels(
  grid: Float32Array,
  cols: number,
  rows: number,
  options: AdaptiveIsolineLevelOptions = {}
): AdaptiveIsolineLevelSelection {
  const requested = Math.max(1, Math.min(128, Math.floor(options.levels ?? 5)));
  const mask = options.validMask;
  const sample: number[] = [];
  const cells = Math.min(grid.length, cols * rows);
  const stride = Math.max(1, Math.ceil(cells / 65_536));
  for (let i = 0; i < cells; i += stride) {
    const value = grid[i];
    if ((!mask || Number(mask[i]) > 0) && Number.isFinite(value) && value > 0) sample.push(value);
  }
  sample.sort((a, b) => a - b);
  if (sample.length < 2 || sample[0] === sample[sample.length - 1]) return empty(sample[0] ?? 0);

  const quantiles = options.outlierQuantiles ?? [0.02, 0.98];
  const qLow = clamp(quantiles[0], 0, 0.49);
  const qHigh = clamp(quantiles[1], 0.51, 1);
  const low = quantile(sample, qLow);
  const high = quantile(sample, qHigh);
  if (!(high > low)) return empty(low);

  const aspect = Math.max(0.25, Math.min(4, cols / Math.max(rows, 1)));
  const zoneCols = Math.max(12, Math.min(48, Math.round(40 * Math.sqrt(aspect))));
  const zoneRows = Math.max(12, Math.min(48, Math.round(40 / Math.sqrt(aspect))));
  const zoneCount = zoneCols * zoneRows;
  const valid = new Uint8Array(zoneCount);
  for (let zy = 0; zy < zoneRows; zy++) for (let zx = 0; zx < zoneCols; zx++) {
    const x = Math.min(cols - 1, Math.round((zx + 0.5) / zoneCols * cols));
    const y = Math.min(rows - 1, Math.round((zy + 0.5) / zoneRows * rows));
    const index = y * cols + x;
    if ((!mask || Number(mask[index]) > 0) && Number.isFinite(grid[index])) valid[zy * zoneCols + zx] = 1;
  }
  const validZones = valid.reduce((sum, value) => sum + value, 0);
  if (!validZones) return empty(low);

  const multiplier = Math.max(5, Math.min(20, Math.floor(options.candidateMultiplier ?? 10)));
  const poolSize = requested * multiplier;
  const candidateValues: number[] = [];
  for (let i = 1; i <= poolSize; i++) {
    const p = i / (poolSize + 1);
    candidateValues.push(quantile(sample, qLow + (qHigh - qLow) * p), low + (high - low) * p);
  }
  candidateValues.sort((a, b) => a - b);
  const unique = candidateValues.filter((value, index) =>
    value > low && value < high && (!index || Math.abs(value - candidateValues[index - 1]) > (high - low) * 1e-6));
  const radius = Math.max(0, Math.min(6, Math.floor(options.coverageRadius ?? 1)));
  const minCells = Math.max(1, Math.floor(options.minCandidateCells ?? 4));
  const candidates: Candidate[] = [];
  for (const level of unique) {
    const candidate = previewCandidate(grid, cols, rows, level, low, high, mask, valid, zoneCols, zoneRows, radius);
    if (candidate.length >= minCells && candidate.covered > 0) candidates.push(candidate);
  }
  if (!candidates.length) return empty(low);

  const words = Math.ceil(zoneCount / 32);
  const union = new Uint32Array(words);
  const remaining = candidates.slice();
  const chosen: Candidate[] = [];
  const selected: AdaptiveIsolineLevelMetric[] = [];
  const weights = {
    coverage: options.coverageWeight ?? 1,
    range: options.rangeWeight ?? 0.18,
    redundancy: options.redundancyWeight ?? 0.22,
    fragment: options.fragmentWeight ?? 0.08
  };
  while (chosen.length < requested && remaining.length) {
    const represented = [false, false, false];
    for (const item of chosen) represented[Math.min(2, Math.floor(item.t * 3))] = true;
    let bestIndex = 0;
    let bestScore = -Infinity;
    let bestGain = 0;
    let bestOverlap = 0;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const bucket = Math.min(2, Math.floor(candidate.t * 3));
      // After the most spatially significant first level, reserve the next two
      // choices for missing low/middle/high thirds when N permits it.
      if (requested >= 3 && chosen.length > 0 && chosen.length < 3 && represented[bucket]) continue;
      const fresh = countNew(candidate.bits, union);
      const gain = fresh / validZones;
      const overlap = candidate.covered ? 1 - fresh / candidate.covered : 1;
      let rangeNovelty = 1;
      for (const prior of chosen) rangeNovelty = Math.min(rangeNovelty, Math.abs(candidate.t - prior.t));
      const rangeBonus = rangeNovelty + (!represented[bucket] ? 0.35 : 0);
      const significance = candidate.covered / validZones;
      const score = weights.coverage * gain + weights.range * rangeBonus + significance * 0.06
        - weights.redundancy * overlap - weights.fragment * candidate.fragmentation;
      if (score > bestScore) {
        bestScore = score; bestIndex = i; bestGain = gain; bestOverlap = overlap;
      }
    }
    const candidate = remaining.splice(bestIndex, 1)[0];
    mergeBits(union, candidate.bits);
    chosen.push(candidate);
    selected.push({
      level: candidate.level,
      gain: bestGain,
      coverage: candidate.covered / validZones,
      redundancy: bestOverlap,
      lengthCells: candidate.length,
      fragmentation: candidate.fragmentation
    });
  }

  const coverage = popcountBits(union) / validZones;
  const uniform = new Uint32Array(words);
  for (let i = 1; i <= requested; i++) {
    const level = low + (high - low) * i / (requested + 1);
    mergeBits(uniform, previewCandidate(grid, cols, rows, level, low, high, mask, valid, zoneCols, zoneRows, radius).bits);
  }
  let redundancy = 0;
  let noiseFraction = 0;
  for (const metric of selected) redundancy += metric.redundancy;
  for (const metric of selected) noiseFraction += metric.fragmentation;
  redundancy = selected.length ? redundancy / selected.length : 0;
  noiseFraction = selected.length ? noiseFraction / selected.length : 0;
  const density = new Uint16Array(zoneCount);
  for (const candidate of chosen) for (let zone = 0; zone < zoneCount; zone++) {
    if (valid[zone] && (candidate.bits[zone >>> 5] & (1 << (zone & 31)))) density[zone]++;
  }
  let meanDensity = 0;
  for (let zone = 0; zone < zoneCount; zone++) if (valid[zone]) meanDensity += density[zone];
  meanDensity /= validZones;
  let distributionVariance = 0;
  for (let zone = 0; zone < zoneCount; zone++) if (valid[zone]) distributionVariance += (density[zone] - meanDensity) ** 2;
  distributionVariance /= validZones;
  const rangeRepresentation = chosen.length > 1
    ? Math.max(...chosen.map((item) => item.t)) - Math.min(...chosen.map((item) => item.t))
    : 0;
  const score = coverage + 0.18 * rangeRepresentation - 0.22 * redundancy - 0.08 * noiseFraction
    - 0.06 * distributionVariance / (1 + distributionVariance);
  return {
    thresholds: chosen.map((item) => item.level).sort((a, b) => a - b),
    selected,
    range: [low, high],
    coverage,
    uniformCoverage: popcountBits(uniform) / validZones,
    redundancy,
    distributionVariance,
    noiseFraction,
    score,
    validZones,
    candidateCount: candidates.length
  };
}

function previewCandidate(
  grid: Float32Array,
  cols: number,
  rows: number,
  level: number,
  low: number,
  high: number,
  mask: ArrayLike<number> | null | undefined,
  valid: Uint8Array,
  zoneCols: number,
  zoneRows: number,
  radius: number
): Candidate {
  const raw = new Uint8Array(zoneCols * zoneRows);
  let length = 0;
  const stepX = Math.max(1, Math.ceil((cols - 1) / 160));
  const stepY = Math.max(1, Math.ceil((rows - 1) / 160));
  for (let y = 0; y < rows - stepY; y += stepY) for (let x = 0; x < cols - stepX; x += stepX) {
    const i = y * cols + x;
    const right = i + stepX, bottom = i + stepY * cols, diagonal = bottom + stepX;
    if (mask && (!(Number(mask[i]) > 0) || !(Number(mask[right]) > 0) ||
      !(Number(mask[bottom]) > 0) || !(Number(mask[diagonal]) > 0))) continue;
    const a = grid[i], b = grid[right], c = grid[bottom], d = grid[diagonal];
    if (![a, b, c, d].every(Number.isFinite)) continue;
    const min = Math.min(a, b, c, d), max = Math.max(a, b, c, d);
    if (min >= level || max < level) continue;
    const zx = Math.min(zoneCols - 1, Math.floor((x + stepX * 0.5) / (cols - 1) * zoneCols));
    const zy = Math.min(zoneRows - 1, Math.floor((y + stepY * 0.5) / (rows - 1) * zoneRows));
    raw[zy * zoneCols + zx] = 1;
    length += Math.max(stepX, stepY);
  }
  const bits = new Uint32Array(Math.ceil(raw.length / 32));
  let rawCount = 0;
  let isolated = 0;
  for (let index = 0; index < raw.length; index++) {
    if (!raw[index]) continue;
    rawCount++;
    const x = index % zoneCols, y = Math.floor(index / zoneCols);
    if (!((x > 0 && raw[index - 1]) || (x + 1 < zoneCols && raw[index + 1]) ||
      (y > 0 && raw[index - zoneCols]) || (y + 1 < zoneRows && raw[index + zoneCols]))) isolated++;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= zoneCols || ny >= zoneRows) continue;
      const target = ny * zoneCols + nx;
      if (valid[target]) bits[target >>> 5] |= 1 << (target & 31);
    }
  }
  return {
    level,
    t: clamp((level - low) / (high - low), 0, 1),
    bits,
    covered: popcountBits(bits),
    length,
    fragmentation: rawCount ? isolated / rawCount : 1
  };
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function countNew(bits: Uint32Array, union: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < bits.length; i++) count += popcount32(bits[i] & ~union[i]);
  return count;
}

function mergeBits(target: Uint32Array, source: Uint32Array): void {
  for (let i = 0; i < source.length; i++) target[i] |= source[i];
}

function popcountBits(bits: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < bits.length; i++) count += popcount32(bits[i]);
  return count;
}

function popcount32(value: number): number {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function nearestLevel(levels: number[], value: number): number {
  let best = 0;
  for (let i = 1; i < levels.length; i++) if (Math.abs(levels[i] - value) < Math.abs(levels[best] - value)) best = i;
  return best;
}

function ringMetrics(ring: HeatIsolineRing, field: HeatFieldGrid): { length: number; area: number } {
  let length = 0;
  let twiceArea = 0;
  let first: [number, number] | undefined;
  let previous: [number, number] | undefined;
  for (const [lat, lng] of ring.coordinates) {
    const merc = projectMercator01(lat, lng);
    const point: [number, number] = [
      (merc.x - field.westMerc) / field.widthMerc * Math.max(1, field.cols - 1),
      (merc.y - field.northMerc) / field.heightMerc * Math.max(1, field.rows - 1)
    ];
    first ??= point;
    if (previous) {
      length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      twiceArea += previous[0] * point[1] - point[0] * previous[1];
    }
    previous = point;
  }
  const closed = Boolean(first && previous && Math.hypot(previous[0] - first[0], previous[1] - first[1]) < 1e-3);
  return { length, area: closed ? Math.abs(twiceArea) * 0.5 : 0 };
}

function empty(value: number): AdaptiveIsolineLevelSelection {
  return {
    thresholds: [], selected: [], range: [value, value], coverage: 0, uniformCoverage: 0,
    redundancy: 0, distributionVariance: 0, noiseFraction: 0, score: 0, validZones: 0, candidateCount: 0
  };
}
import { projectMercator01 } from "../geo.js";
import type { HeatFieldGrid } from "./heat-field.js";
import {
  buildHeatIsolinesFromField,
  type HeatIsolineBuildOptions,
  type HeatIsolineResult,
  type HeatIsolineRing
} from "./heat-isolines.js";
