import { createEl } from "../dom.js";
import { LatLngBounds, latLng, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { PathOptions } from "./vector.js";

export interface CanvasPathBatchOptions extends LayerOptions, PathOptions {
  className?: string;
  /** Device pixel ratio cap. Default 1.5. */
  maxDpr?: number;
}

interface PathRing {
  lat: Float64Array;
  lng: Float64Array;
}

interface PathRecord {
  rings: PathRing[];
  closed: boolean;
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
  fill: string;
  fillOpacity: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Single-canvas batch drawer for many polylines/polygons.
 * Used by GeoJSON `renderer: "canvas"` to avoid one SVG root per feature.
 */
export class CanvasPathBatch extends Layer<CanvasPathBatchOptions> {
  private canvas: HTMLCanvasElement | null = null;
  private records: PathRecord[] = [];
  private _cssW = 0;
  private _cssH = 0;

  constructor(options: CanvasPathBatchOptions = {}) {
    super({
      pane: "overlay",
      className: "oh-canvas-path-batch",
      stroke: "#2563eb",
      strokeWidth: 3,
      strokeOpacity: 1,
      fill: "none",
      fillOpacity: 0.18,
      lineCap: "round",
      lineJoin: "round",
      maxDpr: 1.5,
      interactive: false,
      ...options
    });
  }

  get count(): number {
    return this.records.length;
  }

  clearPaths(): this {
    this.records = [];
    this.render();
    return this;
  }

  /**
   * Add a path from geographic rings. Each ring is [[lat,lng]|LatLng, ...].
   * `closed` true draws a filled polygon (evenodd).
   */
  addPath(rings: LatLngLike[][], closed: boolean, style: PathOptions = {}): this {
    const prepared: PathRing[] = [];
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    for (const ring of rings) {
      if (!ring.length) continue;
      const lat = new Float64Array(ring.length);
      const lng = new Float64Array(ring.length);
      for (let i = 0; i < ring.length; i++) {
        const p = latLng(ring[i]);
        lat[i] = p.lat;
        lng[i] = p.lng;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
      }
      prepared.push({ lat, lng });
    }
    if (!prepared.length) return this;
    this.records.push({
      rings: prepared,
      closed,
      stroke: style.stroke ?? this.options.stroke ?? "#2563eb",
      strokeWidth: style.strokeWidth ?? this.options.strokeWidth ?? 3,
      strokeOpacity: style.strokeOpacity ?? this.options.strokeOpacity ?? 1,
      fill: style.fill ?? this.options.fill ?? "none",
      fillOpacity: style.fillOpacity ?? this.options.fillOpacity ?? 0.18,
      lineCap: style.lineCap ?? this.options.lineCap ?? "round",
      lineJoin: style.lineJoin ?? this.options.lineJoin ?? "round",
      minLat,
      maxLat,
      minLng,
      maxLng
    });
    return this;
  }

  getBounds(): LatLngBounds {
    const bounds = new LatLngBounds();
    for (const record of this.records) {
      bounds.extend([record.minLat, record.minLng]);
      bounds.extend([record.maxLat, record.maxLng]);
    }
    return bounds;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", this.options.className ?? "oh-canvas-path-batch", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    this.render();
  }

  override onRemove(): void {
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this._cssW = 0;
    this._cssH = 0;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.canvas) return;
    const { width, height } = this.map.size;
    const dpr = Math.min(this.options.maxDpr ?? 1.5, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    if (width !== this._cssW || height !== this._cssH) {
      this._cssW = width;
      this._cssH = height;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.canvas.width = Math.max(1, Math.round(width * dpr));
      this.canvas.height = Math.max(1, Math.round(height * dpr));
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const view = this.map.getBounds();
    const padLat = (view.north - view.south) * 0.05 + 0.01;
    const padLng = (view.east - view.west) * 0.05 + 0.01;
    const vMinLat = view.south - padLat;
    const vMaxLat = view.north + padLat;
    const vMinLng = view.west - padLng;
    const vMaxLng = view.east + padLng;

    for (const record of this.records) {
      if (
        record.maxLat < vMinLat
        || record.minLat > vMaxLat
        || record.maxLng < vMinLng
        || record.minLng > vMaxLng
      ) {
        continue;
      }

      ctx.beginPath();
      for (const ring of record.rings) {
        const n = ring.lat.length;
        if (n < 2) continue;
        for (let i = 0; i < n; i++) {
          const pt = this.map.latLngToContainerPoint([ring.lat[i], ring.lng[i]]);
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        if (record.closed) ctx.closePath();
      }

      const hasFill = record.closed && record.fill && record.fill !== "none";
      if (hasFill) {
        ctx.globalAlpha = record.fillOpacity;
        ctx.fillStyle = record.fill;
        ctx.fill("evenodd");
      }
      if (record.strokeWidth > 0 && record.strokeOpacity > 0) {
        ctx.globalAlpha = record.strokeOpacity;
        ctx.strokeStyle = record.stroke;
        ctx.lineWidth = record.strokeWidth;
        ctx.lineCap = record.lineCap;
        ctx.lineJoin = record.lineJoin;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
}

export function canvasPathBatch(options?: CanvasPathBatchOptions): CanvasPathBatch {
  return new CanvasPathBatch(options);
}
