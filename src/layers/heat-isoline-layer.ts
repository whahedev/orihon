import { createEl, rafThrottle } from "../dom.js";
import { latLngBounds, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import {
  buildHeatIsolines,
  type HeatIsolineBuildOptions,
  type HeatIsolineInput,
  type HeatIsolineRing
} from "../services/heat-isolines.js";

/** Same stop map as heatmap layers: keys in 0..1 → CSS colors. */
export type HeatIsolineGradient = Record<number, string>;

export interface HeatIsolineLayerOptions extends LayerOptions, HeatIsolineBuildOptions {
  /**
   * Color ramp by normalized level `t` (0 = cold, 1 = hottest).
   * Same shape as `heatLayer` / `webglHeatLayer` `gradient`.
   * Default: blue → cyan → lime → yellow → red.
   */
  gradient?: HeatIsolineGradient;
  /**
   * When false, all isolines use `color` (flat). Default true — sample `gradient` by level.
   */
  colorByLevel?: boolean;
  /**
   * Flat stroke when `colorByLevel: false`.
   * Also used with `colorHigh` as a 2-stop ramp if `gradient` is omitted.
   */
  color?: string;
  /** @deprecated Prefer `gradient`. Kept as shorthand with `color` for a 2-stop ramp. */
  colorHigh?: string;
  strokeWidth?: number;
  opacity?: number;
  /** Rebuild density+isolines on moveend/zoomend (default true). Pan uses cached rings. */
  dynamic?: boolean;
  /** Bounds pad when sampling the field. Default 0.12. */
  pad?: number;
  /** Draw value captions on isolines. Default true. */
  labels?: boolean;
  /** Format caption text. Default: absolute density level that defines the isoline. */
  labelFormat?: (ring: HeatIsolineRing) => string;
  labelFont?: string;
  /**
   * Label fill. Default `#0f172a` (dark, readable on basemap tiles).
   * Pass `"auto"` to tint labels with the isoline stroke color.
   */
  labelColor?: string | "auto";
  /** Skip labels on rings shorter than this many vertices. Default 3. */
  labelMinVertices?: number;
}

interface ResolvedHeatIsolineOptions extends LayerOptions {
  radius: number;
  blur: number;
  gradient: HeatIsolineGradient;
  colorByLevel: boolean;
  color: string;
  colorHigh: string;
  strokeWidth: number;
  opacity: number;
  dynamic: boolean;
  pad: number;
  labels: boolean;
  labelFormat: (ring: HeatIsolineRing) => string;
  labelFont: string;
  labelColor: string | "auto";
  labelMinVertices: number;
  levels: number | number[];
  cols?: number;
  rows?: number;
  scaleZoom?: number;
  minPeak?: number;
}

export interface HeatIsolineLayerStats {
  points: number;
  rings: number;
  peak: number;
  buildMs: number;
}

/** Heatmap-compatible default: colder = blue, hotter = red. */
const DEFAULT_HEAT_ISOLINE_GRADIENT: HeatIsolineGradient = {
  0.0: "blue",
  0.25: "cyan",
  0.45: "lime",
  0.65: "yellow",
  0.85: "orange",
  1.0: "red"
};

/**
 * Dynamic isolines derived from the same point density field as a heatmap.
 * Rebuilds contours on view settle; reprojects cached rings every frame while panning.
 */
export class HeatIsolineLayer extends Layer<ResolvedHeatIsolineOptions> {
  canvas: HTMLCanvasElement | null = null;
  private _points: HeatIsolineInput[] = [];
  private _rings: HeatIsolineRing[] = [];
  private _peak = 0;
  private _buildMs = 0;
  private _palette: Uint8ClampedArray | null = null;
  private readonly _schedule: () => void;
  private readonly _onView = (): void => this._schedule();
  private readonly _onSettle = (): void => {
    this.rebuild();
  };

  constructor(points: Iterable<HeatIsolineInput> = [], options: HeatIsolineLayerOptions = {}) {
    const {
      dynamic,
      labels,
      labelFormat,
      colorByLevel,
      gradient,
      color,
      colorHigh,
      ...rest
    } = options;
    const resolvedGradient =
      gradient ??
      (color || colorHigh
        ? {
            0: color ?? "#2563eb",
            1: colorHigh ?? color ?? "#b91c1c"
          }
        : DEFAULT_HEAT_ISOLINE_GRADIENT);
    super({
      pane: "overlay",
      attribution: "",
      radius: 28,
      blur: 16,
      color: color ?? "#2563eb",
      colorHigh: colorHigh ?? "#b91c1c",
      strokeWidth: 1.75,
      opacity: 0.88,
      pad: 0.12,
      levels: 5,
      labelFont: "700 13px ui-sans-serif, system-ui, sans-serif",
      labelColor: "#0f172a",
      labelMinVertices: 3,
      ...rest,
      gradient: resolvedGradient,
      colorByLevel: colorByLevel !== false,
      dynamic: dynamic !== false,
      labels: labels !== false,
      labelFormat: labelFormat ?? defaultLabelFormat
    });
    this._schedule = rafThrottle(() => this.render());
    this.setLatLngs(points);
  }

  get count(): number {
    return this._points.length;
  }

  getStats(): HeatIsolineLayerStats {
    return {
      points: this._points.length,
      rings: this._rings.length,
      peak: this._peak,
      buildMs: this._buildMs
    };
  }

  /** Latest isoline rings (lat/lng). */
  getIsolines(): HeatIsolineRing[] {
    return this._rings.slice();
  }

  /** Replace the color ramp (heatmap-style stops 0..1). */
  setGradient(gradient: HeatIsolineGradient): this {
    this.options.gradient = { ...gradient };
    this._palette = null;
    this.render();
    return this;
  }

  getGradient(): HeatIsolineGradient {
    return { ...this.options.gradient };
  }

  /** Toggle level-based coloring vs flat `color`. */
  setColorByLevel(enabled: boolean): this {
    this.options.colorByLevel = Boolean(enabled);
    this.render();
    return this;
  }

  setLatLngs(points: Iterable<HeatIsolineInput>): this {
    this._points = [...points];
    if (this.map) this.rebuild();
    return this;
  }

  addLatLng(point: HeatIsolineInput): this {
    this._points.push(point);
    if (this.map) this.rebuild();
    return this;
  }

  clear(): this {
    this._points = [];
    this._rings = [];
    this._peak = 0;
    this.render();
    return this;
  }

  /** Force density + marching-squares rebuild for the current map view. */
  rebuild(): this {
    const map = this.map;
    if (!map) return this;
    const t0 = performance.now();
    const bounds = latLngBounds(map.getBounds()).pad(this.options.pad);
    const size = map.getSize();
    const cols = this.options.cols ?? Math.max(48, Math.round(size.x / 8));
    const rows = this.options.rows ?? Math.max(36, Math.round(size.y / 8));
    const result = buildHeatIsolines(this._points, bounds, {
      cols,
      rows,
      radius: this.options.radius,
      blur: this.options.blur,
      scaleZoom: this.options.scaleZoom ?? map.getZoom(),
      zoom: map.getZoom(),
      levels: this.options.levels,
      minPeak: this.options.minPeak
    });
    this._rings = result.rings;
    this._peak = result.peak;
    this._buildMs = performance.now() - t0;
    this.render();
    this.emit("rebuild", { stats: this.getStats() });
    return this;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-heat-isoline-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    if (this.options.dynamic) {
      map.on("moveend", this._onSettle);
      map.on("zoomend", this._onSettle);
      map.on("resize", this._onSettle);
    }
    map.on("move", this._onView);
    map.on("zoom", this._onView);
    this.rebuild();
  }

  override onRemove(): void {
    this.map?.off("moveend", this._onSettle);
    this.map?.off("zoomend", this._onSettle);
    this.map?.off("resize", this._onSettle);
    this.map?.off("move", this._onView);
    this.map?.off("zoom", this._onView);
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this._points = [];
    this._rings = [];
    this._peak = 0;
    this._palette = null;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.canvas) return;
    const { width, height } = this.map.size;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round(width * dpr));
    const bh = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!this._rings.length) return;

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = this.options.opacity;
    ctx.lineWidth = this.options.strokeWidth;

    type ScreenRing = {
      ring: HeatIsolineRing;
      points: Array<{ x: number; y: number }>;
      pathLen: number;
      stroke: string;
    };
    const screenRings: ScreenRing[] = [];

    for (const ring of this._rings) {
      if (ring.coordinates.length < 2) continue;
      const stroke = this.#colorForLevel(ring.t);
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      const points: Array<{ x: number; y: number }> = [];
      let pathLen = 0;
      for (let i = 0; i < ring.coordinates.length; i++) {
        const [lat, lng] = ring.coordinates[i];
        const p = this.map.latLngToContainerPoint([lat, lng] as LatLngLike);
        const pt = { x: p.x, y: p.y };
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else {
          ctx.lineTo(pt.x, pt.y);
          const prev = points[points.length - 1];
          pathLen += Math.hypot(pt.x - prev.x, pt.y - prev.y);
        }
        points.push(pt);
      }
      ctx.stroke();
      screenRings.push({ ring, points, pathLen, stroke });
    }

    if (this.options.labels && screenRings.length) {
      // One caption per density level — longest ring that still has an on-screen anchor.
      const byLevel = new Map<string, ScreenRing>();
      for (const item of screenRings) {
        if (item.points.length < this.options.labelMinVertices) continue;
        const key = item.ring.t.toFixed(3);
        const prev = byLevel.get(key);
        if (!prev || item.pathLen > prev.pathLen) byLevel.set(key, item);
      }

      ctx.save();
      ctx.globalAlpha = 1;
      ctx.font = this.options.labelFont;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      for (const item of byLevel.values()) {
        const text = this.options.labelFormat(item.ring);
        if (!text) continue;
        const anchor = pickLabelAnchor(item.points, item.pathLen, width, height);
        if (!anchor) continue;
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.strokeText(text, anchor.x, anchor.y);
        ctx.fillStyle =
          this.options.labelColor === "auto" ? item.stroke : this.options.labelColor;
        ctx.fillText(text, anchor.x, anchor.y);
      }
      ctx.restore();
    }
  }

  #colorForLevel(t: number): string {
    if (!this.options.colorByLevel) return this.options.color;
    const palette = this.#gradientPalette();
    const idx = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
    return `rgb(${palette[idx]},${palette[idx + 1]},${palette[idx + 2]})`;
  }

  #gradientPalette(): Uint8ClampedArray {
    if (this._palette) return this._palette;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this._palette = new Uint8ClampedArray(256 * 4);
      return this._palette;
    }
    const grd = ctx.createLinearGradient(0, 0, 256, 0);
    const stops = Object.entries(this.options.gradient)
      .map(([k, v]) => [Number(k), v] as const)
      .filter(([k]) => Number.isFinite(k))
      .sort((a, b) => a[0] - b[0]);
    if (!stops.length) {
      stops.push([0, "blue"], [1, "red"]);
    }
    for (const [stop, color] of stops) {
      grd.addColorStop(Math.max(0, Math.min(1, stop)), color);
    }
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 256, 1);
    this._palette = ctx.getImageData(0, 0, 256, 1).data;
    return this._palette;
  }
}

export function heatIsolineLayer(
  points?: Iterable<HeatIsolineInput>,
  options?: HeatIsolineLayerOptions
): HeatIsolineLayer {
  return new HeatIsolineLayer(points, options);
}

function defaultLabelFormat(ring: HeatIsolineRing): string {
  const v = ring.value;
  if (!Number.isFinite(v)) return "";
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Prefer ~40% along the path; fall back to any in-view vertex. */
function pickLabelAnchor(
  points: Array<{ x: number; y: number }>,
  pathLen: number,
  width: number,
  height: number,
  margin = 16
): { x: number; y: number } | null {
  const inView = (p: { x: number; y: number }): boolean =>
    p.x >= margin && p.y >= margin && p.x <= width - margin && p.y <= height - margin;

  if (pathLen > 1 && points.length >= 2) {
    const target = pathLen * 0.4;
    let walked = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (walked + seg >= target) {
        const u = seg > 0 ? (target - walked) / seg : 0;
        const mid = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        if (inView(mid)) return mid;
        break;
      }
      walked += seg;
    }
  }

  for (const p of points) {
    if (inView(p)) return p;
  }
  // Last resort: clamp centroid into the viewport so a caption still appears.
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const n = points.length || 1;
  return {
    x: Math.max(margin, Math.min(width - margin, sx / n)),
    y: Math.max(margin, Math.min(height - margin, sy / n))
  };
}
