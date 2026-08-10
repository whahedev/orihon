import { MAX_LAT, TILE_SIZE, latLng, type LatLngBoundsLike, type LatLngLike, latLngBounds } from "../geo.js";

export type HeatIsolineInput = LatLngLike | [number, number, number?];

export interface HeatIsolineBuildOptions {
  /** Grid columns (default 96). */
  cols?: number;
  /** Grid rows (default 72). */
  rows?: number;
  /** Kernel radius in CSS px at `scaleZoom` (mapped into grid cells). Default 28. */
  radius?: number;
  blur?: number;
  scaleZoom?: number;
  /** Map zoom used to size the kernel. */
  zoom?: number;
  /**
   * Contour levels in 0..1 of max density, or a count of evenly spaced levels.
   * Default 5 → [0.2, 0.35, 0.5, 0.65, 0.8].
   */
  levels?: number | number[];
  /** Skip rebuilding if max density is below this. Default 1e-6. */
  minPeak?: number;
}

export interface HeatIsolineRing {
  /** Contour threshold in absolute density units. */
  value: number;
  /** Normalized 0..1 vs grid peak. */
  t: number;
  /** Closed or open rings as [lat, lng][]. */
  coordinates: Array<[number, number]>;
}

export interface HeatIsolineResult {
  cols: number;
  rows: number;
  peak: number;
  rings: HeatIsolineRing[];
}

/**
 * Build a heat-density grid from points and extract isoline rings (marching squares).
 * Dynamic: call again when the view / zoom / data changes.
 */
export function buildHeatIsolines(
  points: Iterable<HeatIsolineInput>,
  boundsLike: LatLngBoundsLike,
  options: HeatIsolineBuildOptions = {}
): HeatIsolineResult {
  const bounds = latLngBounds(boundsLike);
  if (!bounds.isValid()) {
    return { cols: 0, rows: 0, peak: 0, rings: [] };
  }

  const cols = Math.max(8, Math.floor(options.cols ?? 96));
  const rows = Math.max(8, Math.floor(options.rows ?? 72));
  const zoom = options.zoom ?? options.scaleZoom ?? 10;
  const scaleZoom = options.scaleZoom ?? zoom;
  const radiusCss = Math.max(4, (options.radius ?? 28) + (options.blur ?? 16) * 0.35);
  const radiusScale = heatRadiusScale(zoom, scaleZoom);
  const kernelCss = radiusCss * radiusScale;

  const west = bounds.west;
  const east = bounds.east;
  const south = bounds.south;
  const north = bounds.north;
  const widthLng = Math.max(1e-9, east - west);
  const heightLat = Math.max(1e-9, north - south);

  // Approximate CSS px across the bounds at this zoom (Web Mercator).
  const scale = TILE_SIZE * 2 ** zoom;
  const mercW = Math.abs(lngToMercatorX(east) - lngToMercatorX(west)) * scale;
  const mercH = Math.abs(latToMercatorY(north) - latToMercatorY(south)) * scale;
  const cssSpan = Math.max(mercW, mercH, 1);
  const cellCss = cssSpan / Math.max(cols, rows);
  const radiusCells = Math.max(1.25, kernelCss / cellCss);

  const grid = new Float32Array(cols * rows);
  const rCeil = Math.ceil(radiusCells);
  const r2 = radiusCells * radiusCells;

  for (const raw of points) {
    const next = normalizeHeat(raw);
    if (!next) continue;
    if (next.lat < south || next.lat > north || next.lng < west || next.lng > east) continue;

    const fx = ((next.lng - west) / widthLng) * (cols - 1);
    const fy = ((north - next.lat) / heightLat) * (rows - 1);
    const x0 = Math.max(0, Math.floor(fx) - rCeil);
    const x1 = Math.min(cols - 1, Math.ceil(fx) + rCeil);
    const y0 = Math.max(0, Math.floor(fy) - rCeil);
    const y1 = Math.min(rows - 1, Math.ceil(fy) + rCeil);
    const w = next.weight;

    for (let y = y0; y <= y1; y++) {
      const dy = y - fy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - fx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const falloff = 1 - Math.sqrt(d2) / radiusCells;
        grid[y * cols + x] += w * falloff * falloff;
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > peak) peak = grid[i];
  const minPeak = options.minPeak ?? 1e-6;
  if (peak < minPeak) {
    return { cols, rows, peak, rings: [] };
  }

  const thresholds = resolveLevels(options.levels, peak);
  const rings: HeatIsolineRing[] = [];

  for (const value of thresholds) {
    const segments = marchingSquaresSegments(grid, cols, rows, value);
    const chains = connectSegments(segments);
    for (const chain of chains) {
      if (chain.length < 2) continue;
      const coordinates: Array<[number, number]> = chain.map(([gx, gy]) => [
        north - (gy / (rows - 1)) * heightLat,
        west + (gx / (cols - 1)) * widthLng
      ]);
      rings.push({
        value,
        t: value / peak,
        coordinates
      });
    }
  }

  return { cols, rows, peak, rings };
}

function resolveLevels(levels: number | number[] | undefined, peak: number): number[] {
  if (Array.isArray(levels) && levels.length) {
    return levels
      .map((v) => (v > 1 ? v : v * peak))
      .filter((v) => v > 0 && v < peak * 0.999)
      .sort((a, b) => a - b);
  }
  const count = Math.max(1, Math.min(24, Math.floor(typeof levels === "number" ? levels : 5)));
  const defaults = count === 5 ? [0.2, 0.35, 0.5, 0.65, 0.8] : null;
  const fracs =
    defaults ??
    Array.from({ length: count }, (_, i) => (i + 1) / (count + 1));
  return fracs.map((f) => f * peak);
}

/** Marching-squares edge segments in grid coordinates. */
function marchingSquaresSegments(
  grid: Float32Array,
  cols: number,
  rows: number,
  threshold: number
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
          // Saddle — pick consistent pairing via average
          const avg = (tl + tr + br + bl) * 0.25;
          if (avg >= threshold) {
            out.push([left, top], [bottom, right]);
          } else {
            out.push([left, bottom], [top, right]);
          }
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
          if (avg >= threshold) {
            out.push([left, bottom], [top, right]);
          } else {
            out.push([left, top], [bottom, right]);
          }
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

  // Adjacency by endpoint key
  const ends = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i];
    const ka = key(a);
    const kb = key(b);
    let la = ends.get(ka);
    if (!la) {
      la = [];
      ends.set(ka, la);
    }
    la.push(i);
    let lb = ends.get(kb);
    if (!lb) {
      lb = [];
      ends.set(kb, lb);
    }
    lb.push(i);
  }

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const [a0, b0] = segments[start];
    const chain: Array<[number, number]> = [a0, b0];

    // Extend forward from b0
    let head = b0;
    for (;;) {
      const candidates = ends.get(key(head));
      if (!candidates) break;
      let nextIdx = -1;
      for (const idx of candidates) {
        if (!used[idx]) {
          nextIdx = idx;
          break;
        }
      }
      if (nextIdx < 0) break;
      used[nextIdx] = 1;
      const [a, b] = segments[nextIdx];
      if (key(a) === key(head)) {
        chain.push(b);
        head = b;
      } else {
        chain.push(a);
        head = a;
      }
    }

    // Extend backward from a0
    let tail = a0;
    for (;;) {
      const candidates = ends.get(key(tail));
      if (!candidates) break;
      let nextIdx = -1;
      for (const idx of candidates) {
        if (!used[idx]) {
          nextIdx = idx;
          break;
        }
      }
      if (nextIdx < 0) break;
      used[nextIdx] = 1;
      const [a, b] = segments[nextIdx];
      if (key(a) === key(tail)) {
        chain.unshift(b);
        tail = b;
      } else {
        chain.unshift(a);
        tail = a;
      }
    }

    chains.push(chain);
  }

  return chains;
}

function normalizeHeat(value: HeatIsolineInput): { lat: number; lng: number; weight: number } | null {
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

function lngToMercatorX(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return (wrapped + 180) / 360;
}

function latToMercatorY(lat: number): number {
  let clamped = lat;
  if (clamped > MAX_LAT) clamped = MAX_LAT;
  else if (clamped < -MAX_LAT) clamped = -MAX_LAT;
  const sin = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

function heatRadiusScale(zoom: number, scaleZoom: number): number {
  const dz = zoom - scaleZoom;
  if (dz >= 0) return 1;
  const geo = Math.pow(2, dz);
  return Math.max(0.22, geo * 0.55 + 0.45 * Math.pow(geo, 0.35));
}
