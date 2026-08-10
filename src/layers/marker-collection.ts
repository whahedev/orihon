import { rafThrottle } from "../dom.js";
import { latLng, latLngBounds, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { SpatialGridIndex } from "../services/spatial-grid-index.js";
import { Marker, type MarkerOptions } from "./marker.js";
import { WebGLPointLayer, webglPointLayer } from "./webgl-point-layer.js";

export type MarkerCollectionRenderer = "auto" | "dom" | "webgl";

export interface MarkerCollectionOptions extends LayerOptions {
  /**
   * - `dom` — Marker elements (fine for hundreds / low thousands)
   * - `webgl` — GPU points (50k–250k+)
   * - `auto` — webgl when size ≥ `webglThreshold`
   */
  renderer?: MarkerCollectionRenderer;
  /** Default 2500. */
  webglThreshold?: number;
  /** DOM path: only mount markers in padded viewport. Default true. */
  viewportCull?: boolean;
  marker?: MarkerOptions;
  pointSize?: number;
  color?: string;
  opacity?: number;
  indexCellSize?: number;
}

type ResolvedMarkerCollectionOptions = LayerOptions &
  Required<Omit<MarkerCollectionOptions, "marker" | keyof LayerOptions>> & {
    marker: MarkerOptions;
  };

/**
 * Large point sets as markers without mounting 50k DOM nodes.
 * Auto path uses WebGL above `webglThreshold`; DOM path viewport-culls.
 */
export class MarkerCollection extends Layer<ResolvedMarkerCollectionOptions> {
  readonly index: SpatialGridIndex<{ i: number }, number>;
  private _points: LatLngLike[] = [];
  private _markers = new Map<number, Marker>();
  private _webgl: WebGLPointLayer | null = null;
  private _active: "dom" | "webgl" = "dom";
  private readonly _schedule: () => void;
  private readonly _onView = (): void => this._schedule();

  constructor(points: Iterable<LatLngLike> = [], options: MarkerCollectionOptions = {}) {
    const markerOpts: MarkerOptions = { keyboard: false, ...(options.marker ?? {}) };
    super({
      pane: "overlay",
      renderer: "auto",
      webglThreshold: 2500,
      viewportCull: true,
      pointSize: 8,
      color: "#0f766e",
      opacity: 0.88,
      indexCellSize: 1,
      ...options,
      marker: markerOpts
    });
    this.options.webglThreshold = Math.max(1, Math.floor(this.options.webglThreshold));
    this.index = new SpatialGridIndex(this.options.indexCellSize);
    this._schedule = rafThrottle(() => this.redraw());
    this.setLatLngs(points);
  }

  get size(): number {
    return this._points.length;
  }

  get renderer(): "dom" | "webgl" {
    return this._active;
  }

  setLatLngs(points: Iterable<LatLngLike>): this {
    this._points = [...points];
    this.index.clear();
    for (let i = 0; i < this._points.length; i++) {
      const ll = latLng(this._points[i]);
      if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) continue;
      this.index.set(i, ll, { i });
    }
    this.#clearRendered();
    if (this.map) this.redraw();
    return this;
  }

  addLatLng(point: LatLngLike): this {
    const i = this._points.length;
    this._points.push(point);
    const ll = latLng(point);
    if (Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) this.index.set(i, ll, { i });
    if (this.map) this.redraw();
    return this;
  }

  clear(): this {
    this._points = [];
    this.index.clear();
    this.#clearRendered();
    return this;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    map.on("moveend", this._onView);
    map.on("zoomend", this._onView);
    map.on("resize", this._onView);
    this.redraw();
  }

  override onRemove(): void {
    this.map?.off("moveend", this._onView);
    this.map?.off("zoomend", this._onView);
    this.map?.off("resize", this._onView);
    this.#clearRendered();
    super.onRemove();
  }

  override render(): void {
    // DOM/WebGL sync is moveend-driven; avoid per-frame thrash.
  }

  redraw(): this {
    const map = this.map;
    if (!map) return this;
    const useWebgl = this.#shouldUseWebgl();
    this._active = useWebgl ? "webgl" : "dom";

    if (useWebgl) {
      this.#clearDomMarkers();
      this.#syncWebgl();
      return this;
    }

    this.#clearWebgl();
    this.#syncDomMarkers();
    return this;
  }

  #shouldUseWebgl(): boolean {
    const mode = this.options.renderer;
    if (mode === "webgl") return true;
    if (mode === "dom") return false;
    return this.index.size >= this.options.webglThreshold;
  }

  #syncWebgl(): void {
    if (!this.map) return;
    const pts: LatLngLike[] = [];
    for (const record of this.index.records.values()) {
      pts.push(record.position);
    }
    if (!this._webgl) {
      this._webgl = webglPointLayer(pts, {
        pointSize: this.options.pointSize,
        color: this.options.color,
        opacity: this.options.opacity,
        interactive: false,
        maxDpr: 1.5
      });
      this._webgl.addTo(this.map);
    } else {
      this._webgl.setData(pts);
    }
  }

  #syncDomMarkers(): void {
    if (!this.map) return;
    const bounds = this.options.viewportCull
      ? latLngBounds(this.map.getBounds()).pad(0.12)
      : null;

    const visible = new Set<number>();
    if (bounds) {
      for (const record of this.index.search(bounds)) visible.add(record.id);
    } else {
      for (const id of this.index.records.keys()) visible.add(id);
    }

    for (const [id, marker] of this._markers) {
      if (visible.has(id)) continue;
      marker.remove();
      this._markers.delete(id);
    }

    for (const id of visible) {
      if (this._markers.has(id)) continue;
      const record = this.index.records.get(id);
      if (!record) continue;
      const created = new Marker(record.position, this.options.marker);
      created.addTo(this.map as Orihon);
      this._markers.set(id, created);
    }
  }

  #clearDomMarkers(): void {
    for (const marker of this._markers.values()) marker.remove();
    this._markers.clear();
  }

  #clearWebgl(): void {
    if (this._webgl) {
      this._webgl.remove();
      this._webgl = null;
    }
  }

  #clearRendered(): void {
    this.#clearDomMarkers();
    this.#clearWebgl();
    this._active = "dom";
  }
}

export function markerCollection(
  points?: Iterable<LatLngLike>,
  options?: MarkerCollectionOptions
): MarkerCollection {
  return new MarkerCollection(points, options);
}
