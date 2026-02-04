import { createEl } from "../dom.js";
import { latLng, bounds, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
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
export class WebGLPolygonBatch extends Layer<Required<WebGLPolygonBatchOptions>> {
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

/** Simple ear clipping for a single ring packed as lat/lng pairs. Returns triangle lat/lng verts. */
export function earcutRing(ring: Float64Array): Float32Array {
  const n = ring.length / 2;
  if (n < 3) return new Float32Array(0);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) indices.push(i);
  // Ensure CCW in lng/lat plane for ear clipping.
  if (ringArea(ring) > 0) indices.reverse();
  const tris: number[] = [];
  let guard = 0;
  while (indices.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < indices.length; i++) {
      const i0 = indices[(i + indices.length - 1) % indices.length];
      const i1 = indices[i];
      const i2 = indices[(i + 1) % indices.length];
      if (!isEar(ring, indices, i0, i1, i2)) continue;
      tris.push(ring[i0 * 2], ring[i0 * 2 + 1], ring[i1 * 2], ring[i1 * 2 + 1], ring[i2 * 2], ring[i2 * 2 + 1]);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (indices.length === 3) {
    const [a, b, c] = indices;
    tris.push(ring[a * 2], ring[a * 2 + 1], ring[b * 2], ring[b * 2 + 1], ring[c * 2], ring[c * 2 + 1]);
  }
  return Float32Array.from(tris);
}

function ringArea(ring: Float64Array): number {
  let area = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += ring[j * 2 + 1] * ring[i * 2] - ring[i * 2 + 1] * ring[j * 2];
  }
  return area / 2;
}

function isEar(ring: Float64Array, indices: number[], i0: number, i1: number, i2: number): boolean {
  const ax = ring[i0 * 2 + 1];
  const ay = ring[i0 * 2];
  const bx = ring[i1 * 2 + 1];
  const by = ring[i1 * 2];
  const cx = ring[i2 * 2 + 1];
  const cy = ring[i2 * 2];
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (cross <= 0) return false;
  for (const idx of indices) {
    if (idx === i0 || idx === i1 || idx === i2) continue;
    if (pointInTriangle(ring[idx * 2 + 1], ring[idx * 2], ax, ay, bx, by, cx, cy)) return false;
  }
  return true;
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const inv = 1 / Math.max(1e-12, dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

// silence unused LatLngLike in public typings consumers
export type { LatLngLike };
