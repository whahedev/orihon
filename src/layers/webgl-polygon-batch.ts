import { createEl } from "../dom.js";
import { latLng, bounds } from "../geo.js";
import { InteractiveLayer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import { clampOpacity, parseCssColor } from "../webgl-utils.js";
import { pointInRing } from "../services/object-geometry.js";

export interface PolygonBatchStyle {
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
}

export interface PolygonBatchInput {
  /** Rings as lat/lng positions (ObjectManager normalized order). */
  rings: Array<ArrayLike<number>>;
  style?: PolygonBatchStyle;
  id?: string | number;
}

export interface WebGLPolygonBatchOptions extends LayerOptions {
  maxDpr?: number;
  fallbackCanvas?: boolean;
  hitTolerance?: number;
  interactive?: boolean;
}

interface StoredPolygon {
  rings: Float64Array[];
  style: Required<PolygonBatchStyle>;
  id: string | number | null;
  bbox: readonly [number, number, number, number];
  fillCss: string;
  strokeCss: string;
}

/**
 * Polygon fill/stroke batch (canvas).
 * Triangulation is deferred until a real WebGL fill path exists — canvas uses even-odd fill.
 */
export class WebGLPolygonBatch extends InteractiveLayer<Required<WebGLPolygonBatchOptions>> {
  canvas: HTMLCanvasElement | null = null;
  renderer: "canvas" | "none" = "none";
  private polygons: StoredPolygon[] = [];
  private _dataVersion = 0;
  private _paintedVersion = -1;
  private _paintZoom = Number.NaN;
  private _paintOriginX = 0;
  private _paintOriginY = 0;

  constructor(options: WebGLPolygonBatchOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      maxDpr: 1.5,
      fallbackCanvas: true,
      hitTolerance: 0,
      interactive: false,
      ...options
    });
  }

  clearPolygons(): this {
    this.polygons = [];
    this._dataVersion++;
    this.render();
    return this;
  }

  setPolygons(polygons: Iterable<PolygonBatchInput>): this {
    this.polygons = [];
    for (const polygon of polygons) this.addPolygon(polygon);
    this._dataVersion++;
    this.render();
    return this;
  }

  addPolygon(input: PolygonBatchInput): this {
    if (!input.rings?.length) return this;
    const rings: Float64Array[] = [];
    let bbox: readonly [number, number, number, number] | null = null;
    for (const ring of input.rings) {
      if (ring.length < 6) continue;
      const packed = ring instanceof Float64Array ? ring.slice() : Float64Array.from(ring as ArrayLike<number>);
      rings.push(packed);
      for (let i = 0; i < packed.length; i += 2) {
        const lat = packed[i];
        const lng = packed[i + 1];
        if (!bbox) bbox = [lat, lng, lat, lng];
        else {
          bbox = [
            Math.min(bbox[0], lat),
            Math.min(bbox[1], lng),
            Math.max(bbox[2], lat),
            Math.max(bbox[3], lng)
          ];
        }
      }
    }
    if (!rings.length || !bbox) return this;
    const style = {
      fill: input.style?.fill ?? "#0f766e",
      fillOpacity: clampOpacity(input.style?.fillOpacity ?? 0.25),
      stroke: input.style?.stroke ?? "#0f766e",
      strokeOpacity: clampOpacity(input.style?.strokeOpacity ?? 0.85),
      strokeWidth: Math.max(0, Number(input.style?.strokeWidth) || 1.5)
    };
    const fill = parseCssColor(style.fill, { r: 15, g: 118, b: 110 });
    const stroke = parseCssColor(style.stroke, { r: 15, g: 118, b: 110 });
    this.polygons.push({
      rings,
      style,
      id: input.id ?? null,
      bbox,
      fillCss: `rgba(${fill.r},${fill.g},${fill.b},${style.fillOpacity})`,
      strokeCss: `rgba(${stroke.r},${stroke.g},${stroke.b},${style.strokeOpacity})`
    });
    this._dataVersion++;
    return this;
  }

  override onAdd(map: Orihon): void {
    assertMercator(map.crs);
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-webgl-polygon-batch", pane);
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

  queryHit(point: { x: number; y: number }, _options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const ll = this.map.containerPointToLatLng(point);
    for (let i = this.polygons.length - 1; i >= 0; i--) {
      const polygon = this.polygons[i];
      if (ll.lat < polygon.bbox[0] || ll.lat > polygon.bbox[2] || ll.lng < polygon.bbox[1] || ll.lng > polygon.bbox[3]) {
        continue;
      }
      if (!pointInRing(ll.lat, ll.lng, polygon.rings[0])) continue;
      let inHole = false;
      for (let r = 1; r < polygon.rings.length; r++) {
        if (pointInRing(ll.lat, ll.lng, polygon.rings[r])) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;
      return {
        layer: this,
        latlng: latLng({ lat: ll.lat, lng: ll.lng }),
        source: "webgl",
        index: i,
        id: polygon.id ?? undefined,
        feature: polygon
      };
    }
    return null;
  }

  override render(): void {
    if (!this.map || !this.canvas || this.renderer === "none") return;
    const map = this.map;
    const zoom = map.zoom;
    const ox = map.pixelOrigin.x;
    const oy = map.pixelOrigin.y;
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
    for (const polygon of this.polygons) {
      if (
        polygon.bbox[2] < view.south ||
        polygon.bbox[0] > view.north ||
        polygon.bbox[3] < view.west ||
        polygon.bbox[1] > view.east
      ) {
        continue;
      }
      ctx.beginPath();
      for (let r = 0; r < polygon.rings.length; r++) {
        const ring = polygon.rings[r];
        for (let i = 0; i < ring.length; i += 2) {
          const pt = map.latLngToContainerPoint({ lat: ring[i], lng: ring[i + 1] });
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = polygon.fillCss;
      ctx.fill("evenodd");
      if (polygon.style.strokeWidth > 0) {
        ctx.strokeStyle = polygon.strokeCss;
        ctx.lineWidth = polygon.style.strokeWidth;
        ctx.stroke();
      }
    }
    this._paintedVersion = this._dataVersion;
    this._paintZoom = zoom;
    this._paintOriginX = ox;
    this._paintOriginY = oy;
  }
}

export function webglPolygonBatch(options?: WebGLPolygonBatchOptions): WebGLPolygonBatch {
  return new WebGLPolygonBatch(options);
}
