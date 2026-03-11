import { createEl } from "../dom.js";
import { Layer, type LayerOptions } from "../layer.js";
import { latLng, type LatLng, type LatLngLike, type Point } from "../geo.js";
import type { Orihon } from "../map.js";
import type { PointLike } from "../geo.js";
import type { QueryHit, ResolvedQueryOptions } from "../layer.js";

export type ClusterCanvasItem = {
  key: string;
  lat: number;
  lng: number;
  count: number;
};

export type ClusterCanvasLayerOptions = LayerOptions & {
  pane?: string;
  hitTolerance?: number;
};

type DrawnCluster = ClusterCanvasItem & {
  x: number;
  y: number;
  radius: number;
};

function tierStyle(count: number): { radius: number; fill: string; stroke: string } {
  // Match `.oh-cluster-icon--sm|md|lg` in orihon.css
  if (count < 10) return { radius: 18, fill: "#14b8a6", stroke: "rgba(255,255,255,0.9)" };
  if (count < 100) return { radius: 24, fill: "#0f766e", stroke: "rgba(255,255,255,0.9)" };
  return { radius: 30, fill: "#c2410c", stroke: "rgba(255,255,255,0.9)" };
}

/**
 * Single-canvas cluster badges (OpenLayers-style): one redraw per frame, no DOM Markers.
 */
export interface ClusterCanvasEventMap {
  clusterclick: { originalEvent: MouseEvent; clusterKey: string; latlng: LatLngLike; count: number };
}

export class ClusterCanvasLayer extends Layer<LayerOptions, ClusterCanvasEventMap> {
  declare options: ClusterCanvasLayerOptions;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private items: ClusterCanvasItem[] = [];
  private drawn: DrawnCluster[] = [];
  private dpr = 1;

  constructor(options: ClusterCanvasLayerOptions = {}) {
    super({ pane: "marker", hitTolerance: 8, ...options });
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = map.getPane(this.options.pane ?? "marker");
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane ?? "marker"}`);
    this.canvas = createEl("canvas", "oh-cluster-canvas", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "auto";
    this.ctx = this.canvas.getContext("2d");
    this.canvas.addEventListener("click", this._onClick);
    this._resize();
    this._draw();
  }

  override onRemove(): void {
    this.canvas?.removeEventListener("click", this._onClick);
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.drawn = [];
    super.onRemove();
  }

  setClusters(items: ClusterCanvasItem[]): this {
    this.items = items;
    this._draw();
    return this;
  }

  clear(): this {
    this.items = [];
    this.drawn = [];
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return this;
  }

  queryAt(containerPoint: PointLike, tolerance = this.options.hitTolerance ?? 8): ClusterCanvasItem | null {
    const x = Array.isArray(containerPoint) ? containerPoint[0] : containerPoint.x;
    const y = Array.isArray(containerPoint) ? containerPoint[1] : containerPoint.y;
    let best: DrawnCluster | null = null;
    let bestDist = Infinity;
    for (const d of this.drawn) {
      const dx = d.x - x;
      const dy = d.y - y;
      const dist = Math.hypot(dx, dy);
      const hit = Math.max(d.radius, tolerance);
      if (dist <= hit && dist < bestDist) {
        best = d;
        bestDist = dist;
      }
    }
    return best ? { key: best.key, lat: best.lat, lng: best.lng, count: best.count } : null;
  }

  queryHit(point: Point, options: ResolvedQueryOptions): QueryHit | null {
    const hit = this.queryAt(point, options.tolerance);
    return hit ? {
      layer: this,
      latlng: latLng({ lat: hit.lat, lng: hit.lng }),
      source: "cluster",
      id: hit.key,
      feature: hit
    } : null;
  }

  override render(): void {
    this._draw();
  }

  private _onClick = (ev: MouseEvent): void => {
    const map = this.map;
    if (!map || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const pt = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    const hit = this.queryAt(pt);
    if (!hit) return;
    this.emit("clusterclick", {
      originalEvent: ev,
      clusterKey: hit.key,
      latlng: { lat: hit.lat, lng: hit.lng } as LatLng,
      count: hit.count
    });
  };

  private _resize(): void {
    const map = this.map;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const size = map.getSize();
    this.dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const w = Math.max(1, Math.round(size.x));
    const h = Math.max(1, Math.round(size.y));
    const bw = Math.round(w * this.dpr);
    const bh = Math.round(h * this.dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = this.ctx;
    if (ctx) ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private _draw(): void {
    const map = this.map;
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!map || !ctx || !canvas) return;
    this._resize();
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    this.drawn = [];
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 12px system-ui,Segoe UI,sans-serif";
    for (const item of this.items) {
      const p = map.latLngToContainerPoint({ lat: item.lat, lng: item.lng } as LatLngLike);
      const style = tierStyle(item.count);
      if (
        p.x < -style.radius ||
        p.y < -style.radius ||
        p.x > size.x + style.radius ||
        p.y > size.y + style.radius
      ) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, style.radius, 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = style.stroke;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.fillText(String(item.count), p.x, p.y);
      this.drawn.push({ ...item, x: p.x, y: p.y, radius: style.radius });
    }
  }
}

export function clusterCanvasLayer(options?: ClusterCanvasLayerOptions): ClusterCanvasLayer {
  return new ClusterCanvasLayer(options);
}
