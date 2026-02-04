import { createEl } from "../dom.js";
import { latLng, bounds, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import { clampOpacity, parseCssColor } from "../webgl-utils.js";
import { normalizeDashArray } from "./vector.js";
import type { ObjectGradientStop } from "../services/object-types.js";
import { approxHaversineMeters } from "../services/object-geometry.js";

export interface StyledPathStyle {
  color?: string;
  opacity?: number;
  width?: number;
  dashArray?: readonly number[] | string | null;
  dashOffset?: number;
  gradient?: readonly ObjectGradientStop[] | null;
}

export interface StyledPathInput {
  positions: LatLngLike[];
  distances?: ArrayLike<number>;
  style?: StyledPathStyle;
  id?: string | number;
}

export interface WebGLStyledPathBatchOptions extends LayerOptions {
  maxDpr?: number;
  fallbackCanvas?: boolean;
  interactive?: boolean;
}

/**
 * Path batch with distance-along-line support for dash + gradient.
 * Canvas renderer guarantees dash+gradient combinations; API is WebGL-ready.
 */
export class WebGLStyledPathBatch extends Layer<Required<WebGLStyledPathBatchOptions>> {
  canvas: HTMLCanvasElement | null = null;
  renderer: "canvas" | "none" = "none";
  private paths: Array<{
    lat: Float64Array;
    lng: Float64Array;
    distances: Float64Array;
    style: Required<StyledPathStyle>;
    id: string | number | null;
    bbox: readonly [number, number, number, number];
  }> = [];
  /** Full canvas paint is expensive; pan at same zoom uses CSS translate instead. */
  private _dataVersion = 0;
  private _paintedVersion = -1;
  private _paintZoom = Number.NaN;
  private _paintOriginX = 0;
  private _paintOriginY = 0;

  constructor(options: WebGLStyledPathBatchOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      maxDpr: 1.5,
      fallbackCanvas: true,
      interactive: false,
      ...options
    });
  }

  clearPaths(): this {
    this.paths = [];
    this._dataVersion++;
    this.render();
    return this;
  }

  setPaths(paths: Iterable<StyledPathInput>): this {
    this.paths = [];
    for (const path of paths) this.addPath(path);
    this._dataVersion++;
    this.render();
    return this;
  }

  addPath(path: StyledPathInput): this {
    if (!path.positions || path.positions.length < 2) return this;
    const n = path.positions.length;
    const lat = new Float64Array(n);
    const lng = new Float64Array(n);
    const distances = new Float64Array(n);
    let length = 0;
    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = latLng(path.positions[i]);
      lat[i] = p.lat;
      lng[i] = p.lng;
      minLat = Math.min(minLat, p.lat);
      minLng = Math.min(minLng, p.lng);
      maxLat = Math.max(maxLat, p.lat);
      maxLng = Math.max(maxLng, p.lng);
      if (path.distances && path.distances.length > i) {
        distances[i] = Number(path.distances[i]) || 0;
      } else if (i > 0) {
        length += approxHaversineMeters(lat[i - 1], lng[i - 1], p.lat, p.lng);
        distances[i] = length;
      }
    }
    this.paths.push({
      lat,
      lng,
      distances,
      style: normalizeStyle(path.style),
      id: path.id ?? null,
      bbox: [minLat, minLng, maxLat, maxLng]
    });
    this._dataVersion++;
    return this;
  }

  override onAdd(map: Orihon): void {
    assertMercator(map.crs);
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-webgl-styled-path-batch", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    this.renderer = "canvas";
    this.render();
  }

  override onRemove(): void {
    this.canvas?.remove();
    this.canvas = null;
    this.renderer = "none";
    super.onRemove();
  }

  queryHit(point: { x: number; y: number }, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const tolerance = Math.max(options.tolerance ?? 0, 4);
    let best: { index: number; dist: number } | null = null;
    for (let i = this.paths.length - 1; i >= 0; i--) {
      const path = this.paths[i];
      const hitTol = Math.max(tolerance, path.style.width * 0.5 + 2);
      const dist = this.#distanceToPath(point, path);
      if (dist == null || dist > hitTol) continue;
      if (!best || dist < best.dist) best = { index: i, dist };
    }
    if (!best) return null;
    const path = this.paths[best.index];
    return {
      layer: this,
      latlng: this.map.containerPointToLatLng(point),
      source: "webgl",
      index: best.index,
      id: path.id ?? undefined,
      feature: path
    };
  }

  override render(): void {
    if (!this.map || !this.canvas || this.renderer === "none") return;
    const map = this.map;
    const zoom = map.zoom;
    const ox = map.pixelOrigin.x;
    const oy = map.pixelOrigin.y;
    // Pan at constant zoom: shift the last paint instead of reprojecting every vertex.
    if (
      this._paintedVersion === this._dataVersion &&
      zoom === this._paintZoom &&
      Number.isFinite(this._paintZoom)
    ) {
      const dx = this._paintOriginX - ox;
      const dy = this._paintOriginY - oy;
      if (dx * dx + dy * dy < 96 * 96) {
        this.canvas.style.transform = `translate(${dx}px, ${dy}px)`;
        return;
      }
    }

    this.canvas.style.transform = "none";
    const dpr = Math.min(this.options.maxDpr, window.devicePixelRatio || 1);
    const { width, height } = map.size;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const view = bounds(map.getBounds()).pad(0.15);
    for (const path of this.paths) {
      if (
        path.bbox[2] < view.south ||
        path.bbox[0] > view.north ||
        path.bbox[3] < view.west ||
        path.bbox[1] > view.east
      ) {
        continue;
      }
      this.#strokePath(ctx, path);
    }
    this._paintedVersion = this._dataVersion;
    this._paintZoom = zoom;
    this._paintOriginX = ox;
    this._paintOriginY = oy;
  }

  #strokePath(
    ctx: CanvasRenderingContext2D,
    path: { lat: Float64Array; lng: Float64Array; distances: Float64Array; style: Required<StyledPathStyle> }
  ): void {
    if (!this.map || path.lat.length < 2) return;
    const total = Math.max(path.distances[path.distances.length - 1], 1e-6);
    const dash = path.style.dashArray as number[];
    const hasGradient = Boolean(path.style.gradient?.length);

    if (hasGradient) {
      for (let i = 1; i < path.lat.length; i++) {
        const a = this.map.latLngToContainerPoint({ lat: path.lat[i - 1], lng: path.lng[i - 1] });
        const b = this.map.latLngToContainerPoint({ lat: path.lat[i], lng: path.lng[i] });
        const t = path.distances[i] / total;
        ctx.strokeStyle = sampleGradient(path.style.gradient!, t);
        ctx.globalAlpha = path.style.opacity;
        ctx.lineWidth = path.style.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (dash.length) {
          ctx.setLineDash(dash);
          ctx.lineDashOffset = -(path.style.dashOffset + path.distances[i - 1]);
        } else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      return;
    }

    ctx.beginPath();
    for (let i = 0; i < path.lat.length; i++) {
      const pt = this.map.latLngToContainerPoint({ lat: path.lat[i], lng: path.lng[i] });
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = path.style.color;
    ctx.globalAlpha = path.style.opacity;
    ctx.lineWidth = path.style.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (dash.length) {
      ctx.setLineDash(dash);
      ctx.lineDashOffset = -path.style.dashOffset;
    } else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  #distanceToPath(
    point: { x: number; y: number },
    path: { lat: Float64Array; lng: Float64Array }
  ): number | null {
    if (!this.map || path.lat.length < 2) return null;
    let best = Infinity;
    for (let i = 1; i < path.lat.length; i++) {
      const a = this.map.latLngToContainerPoint({ lat: path.lat[i - 1], lng: path.lng[i - 1] });
      const b = this.map.latLngToContainerPoint({ lat: path.lat[i], lng: path.lng[i] });
      const dist = distanceToSegment(point.x, point.y, a.x, a.y, b.x, b.y);
      if (dist < best) best = dist;
    }
    return Number.isFinite(best) ? best : null;
  }
}

export function webglStyledPathBatch(options?: WebGLStyledPathBatchOptions): WebGLStyledPathBatch {
  return new WebGLStyledPathBatch(options);
}

function normalizeStyle(style: StyledPathStyle | undefined): Required<StyledPathStyle> {
  return {
    color: style?.color ?? "#2563eb",
    opacity: clampOpacity(style?.opacity ?? 0.85),
    width: Math.max(0.5, Number(style?.width) || 2),
    dashArray: normalizeDashArray((style?.dashArray as string | number[] | null | undefined) ?? null),
    dashOffset: Number(style?.dashOffset) || 0,
    gradient: style?.gradient ? normalizeGradient(style.gradient) : null
  };
}

function normalizeGradient(stops: readonly ObjectGradientStop[]): ObjectGradientStop[] {
  const cleaned = stops
    .map((stop) => ({
      offset: Math.max(0, Math.min(1, Number(stop.offset))),
      color: String(stop.color || "#000")
    }))
    .filter((stop) => Number.isFinite(stop.offset))
    .sort((a, b) => a.offset - b.offset);
  if (cleaned.length < 2) throw new TypeError("ObjectManager: gradient requires at least 2 stops");
  return cleaned;
}

function sampleGradient(stops: readonly ObjectGradientStop[], t: number): string {
  const x = Math.max(0, Math.min(1, t));
  if (x <= stops[0].offset) return stops[0].color;
  if (x >= stops[stops.length - 1].offset) return stops[stops.length - 1].color;
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i].offset) {
      const a = stops[i - 1];
      const b = stops[i];
      const u = (x - a.offset) / Math.max(1e-6, b.offset - a.offset);
      return mixCss(a.color, b.color, u);
    }
  }
  return stops[stops.length - 1].color;
}

function mixCss(a: string, b: string, t: number): string {
  const ca = parseCssColor(a, { r: 0, g: 0, b: 0 });
  const cb = parseCssColor(b, { r: 0, g: 0, b: 0 });
  return `rgb(${Math.round(ca.r + (cb.r - ca.r) * t)},${Math.round(ca.g + (cb.g - ca.g) * t)},${Math.round(ca.b + (cb.b - ca.b) * t)})`;
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
