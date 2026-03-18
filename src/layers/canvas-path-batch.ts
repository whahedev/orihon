import { createEl, listenTap } from "../dom.js";
import { LatLngBounds, latLng, type LatLngLike, type Point } from "../geo.js";
import { Layer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { OverlayContent, PopupOptions } from "../overlays/div-overlay.js";
import { densifyLatLngs, normalizeDashArray, type PathOptions } from "./vector.js";
import { rejectStyleAliases } from "../style-contract.js";

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
  geodesicRings: PathRing[] | null;
  closed: boolean;
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
  fill: string;
  fillOpacity: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  dashArray: number[];
  dashOffset: number;
  arrow: boolean | "end" | "start" | "both";
  arrowSize: number;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  feature?: unknown;
}

/**
 * Single-canvas batch drawer for many polylines/polygons.
 * Used by GeoJSON `renderer: "canvas"` to avoid one SVG root per feature.
 */
export interface CanvasPathBatchEventMap {
  click: { originalEvent: MouseEvent | PointerEvent; latlng: ReturnType<typeof latLng>; feature: unknown; index: number | undefined };
}

export class CanvasPathBatch extends Layer<CanvasPathBatchOptions, CanvasPathBatchEventMap> {
  private canvas: HTMLCanvasElement | null = null;
  private records: PathRecord[] = [];
  private _cssW = 0;
  private _cssH = 0;
  private _interactionUnsub: (() => void) | null = null;

  constructor(options: CanvasPathBatchOptions = {}) {
    rejectStyleAliases(options, "line");
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
  addPath(rings: LatLngLike[][], closed: boolean, style: PathOptions = {}, feature?: unknown): this {
    rejectStyleAliases(style, "line");
    const prepared: PathRing[] = [];
    const geodesicPrepared: PathRing[] = [];
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    for (const ring of rings) {
      if (!ring.length) continue;
      const values = ring.map((value) => latLng(value));
      const lat = new Float64Array(values.length);
      const lng = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) {
        const p = values[i];
        lat[i] = p.lat;
        lng[i] = p.lng;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
      }
      prepared.push({ lat, lng });
      if (style.geodesic ?? this.options.geodesic) {
        const dense = densifyLatLngs(values, closed);
        const denseLat = new Float64Array(dense.length);
        const denseLng = new Float64Array(dense.length);
        for (let i = 0; i < dense.length; i++) {
          denseLat[i] = dense[i].lat;
          denseLng[i] = dense[i].lng;
          minLat = Math.min(minLat, dense[i].lat);
          maxLat = Math.max(maxLat, dense[i].lat);
          minLng = Math.min(minLng, dense[i].lng);
          maxLng = Math.max(maxLng, dense[i].lng);
        }
        geodesicPrepared.push({ lat: denseLat, lng: denseLng });
      }
    }
    if (!prepared.length) return this;
    this.records.push({
      rings: prepared,
      geodesicRings: geodesicPrepared.length === prepared.length ? geodesicPrepared : null,
      closed,
      stroke: style.stroke ?? this.options.stroke ?? "#2563eb",
      strokeWidth: style.strokeWidth ?? this.options.strokeWidth ?? 3,
      strokeOpacity: style.strokeOpacity ?? this.options.strokeOpacity ?? 1,
      fill: style.fill ?? this.options.fill ?? "none",
      fillOpacity: style.fillOpacity ?? this.options.fillOpacity ?? 0.18,
      lineCap: style.lineCap ?? this.options.lineCap ?? "round",
      lineJoin: style.lineJoin ?? this.options.lineJoin ?? "round",
      dashArray: normalizeDashArray(style.dashArray ?? this.options.dashArray),
      dashOffset: Number(style.dashOffset ?? this.options.dashOffset ?? 0),
      arrow: style.arrow ?? this.options.arrow ?? false,
      arrowSize: Math.max(1, Number(style.arrowSize ?? this.options.arrowSize ?? 10)),
      minLat,
      maxLat,
      minLng,
      maxLng,
      feature
    });
    return this;
  }

  getBounds(): LatLngBounds {
    const bounds = new LatLngBounds();
    for (const record of this.records) {
      bounds.extend({ lat: record.minLat, lng: record.minLng });
      bounds.extend({ lat: record.maxLat, lng: record.maxLng });
    }
    return bounds;
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.setInteractive(true);
    return super.bindPopup(content, options);
  }

  setInteractive(value: boolean): this {
    this.writableOptions.interactive = Boolean(value);
    this.#syncInteraction();
    return this;
  }

  queryHit(target: Point, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    for (let recordIndex = this.records.length - 1; recordIndex >= 0; recordIndex--) {
      const record = this.records[recordIndex];
      const rings = record.geodesicRings && this.map.crs.code === "EPSG:3857" ? record.geodesicRings : record.rings;
      const projected = rings.map((ring) => Array.from({ length: ring.lat.length }, (_, index) =>
        this.map!.latLngToContainerPoint({ lat: ring.lat[index], lng: ring.lng[index] })
      ));
      let inside = false;
      if (record.closed && record.fill !== "none" && record.fillOpacity > 0) {
        for (const ring of projected) if (canvasRingContains(target, ring)) inside = !inside;
      }
      const tolerance = options.tolerance + record.strokeWidth / 2;
      const onStroke = projected.some((ring) => {
        const segments = record.closed ? ring.length : Math.max(0, ring.length - 1);
        for (let index = 0; index < segments; index++) {
          if (canvasSegmentDistance(target, ring[index], ring[(index + 1) % ring.length]) <= tolerance) return true;
        }
        return false;
      });
      if (inside || onStroke) return {
        layer: this,
        latlng: this.map.containerPointToLatLng(target),
        source: "canvas",
        index: recordIndex,
        feature: record.feature
      };
    }
    return null;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", this.options.className ?? "oh-canvas-path-batch", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.#syncInteraction();
    this.render();
  }

  override onRemove(): void {
    this._interactionUnsub?.();
    this._interactionUnsub = null;
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

  #syncInteraction(): void {
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    if (!this.canvas) return;
    this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    if (!this.options.interactive) return;
    this._interactionUnsub = listenTap(this.canvas, (event) => {
      if (!this.map || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const target = { x: event.clientX - rect.left, y: event.clientY - rect.top } as Point;
      const hit = this.queryHit(target, {
        tolerance: 8,
        layers: [this],
        pane: "",
        limit: 1
      });
      if (!hit) return;
      event.stopPropagation();
      this.emit("click", {
        originalEvent: event,
        latlng: hit.latlng,
        feature: hit.feature,
        index: hit.index
      });
    });
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
      const projectedRings: Array<Array<{ x: number; y: number }>> = [];
      const rings = record.geodesicRings && this.map.crs.code === "EPSG:3857" ? record.geodesicRings : record.rings;
      for (const ring of rings) {
        const n = ring.lat.length;
        if (n < 2) continue;
        const projected: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < n; i++) {
          const pt = this.map.latLngToContainerPoint({ lat: ring.lat[i], lng: ring.lng[i] });
          projected.push(pt);
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        projectedRings.push(projected);
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
        ctx.setLineDash(record.dashArray);
        ctx.lineDashOffset = record.dashOffset;
        ctx.stroke();
        if (!record.closed && record.arrow) {
          for (const points of projectedRings) drawCanvasArrows(ctx, points, record.arrow, record.arrowSize);
        }
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  }
}

function canvasSegmentDistance(target: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return Math.hypot(target.x - a.x, target.y - a.y);
  const ratio = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(target.x - a.x - ratio * dx, target.y - a.y - ratio * dy);
}

function canvasRingContains(target: Point, ring: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    if ((a.y > target.y) !== (b.y > target.y)
      && target.x < ((b.x - a.x) * (target.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x) inside = !inside;
  }
  return inside;
}

function drawCanvasArrows(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  arrow: boolean | "end" | "start" | "both",
  size: number
): void {
  if (points.length < 2) return;
  const draw = (tip: { x: number; y: number }, neighbor: { x: number; y: number }): void => {
    const angle = Math.atan2(tip.y - neighbor.y, tip.x - neighbor.x);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - Math.cos(angle - Math.PI / 6) * size, tip.y - Math.sin(angle - Math.PI / 6) * size);
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - Math.cos(angle + Math.PI / 6) * size, tip.y - Math.sin(angle + Math.PI / 6) * size);
    ctx.stroke();
  };
  if (arrow === "start" || arrow === "both") draw(points[0], points[1]);
  if (arrow === true || arrow === "end" || arrow === "both") draw(points.at(-1)!, points.at(-2)!);
}

export function canvasPathBatch(options?: CanvasPathBatchOptions): CanvasPathBatch {
  return new CanvasPathBatch(options);
}
