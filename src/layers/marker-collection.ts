import { cameraWarpCss } from "../camera.js";
import { createEl, createSvgEl, rafThrottle } from "../dom.js";
import { latLng, bounds, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { SpatialGridIndex } from "../services/spatial-grid-index.js";
import { Marker, validateMarkerOptions, type MarkerOptions } from "./marker.js";
import { WebGLPointLayer, webglPointLayer } from "./webgl-point-layer.js";
import { rejectStyleAliases, type RemovedPointStyleAliases } from "../style-contract.js";

export type MarkerCollectionRenderer = "auto" | "dom" | "svg" | "webgl" | "hybrid";

export interface MarkerCollectionOptions extends LayerOptions, RemovedPointStyleAliases {
  /**
   * - `dom` — Marker elements (fine for hundreds / low thousands)
   * - `svg` — one real SVG DOM node per point, with shared style/transform
   * - `webgl` — GPU points (50k–250k+)
   * - `hybrid` — up to `domLimit` Marker elements above a WebGL remainder
   * - `auto` — webgl when size ≥ `webglThreshold`
   */
  renderer?: MarkerCollectionRenderer;
  /** Default 2500. */
  webglThreshold?: number;
  /** Hybrid path: maximum mounted DOM markers. Default 500. */
  domLimit?: number;
  /** SVG path: soft automatic HTML-button budget; selected points may exceed it. Default 0. */
  htmlButtonLimit?: number;
  /** SVG path: screen spacing between automatic buttons. Defaults to max(48px, pointSize × 12); 0 disables thinning. */
  buttonCellSize?: number;
  /**
   * When zoom ≥ this value, force viewport-culled DOM markers (icons) even if
   * the count would otherwise pick WebGL. Use for icon LOD: points far, icons near.
   * Default `Infinity` (disabled).
   */
  iconMinZoom?: number;
  /** DOM path: only mount markers in padded viewport. Default true. */
  viewportCull?: boolean;
  marker?: MarkerOptions;
  pointSize?: number;
  /** Point fill color. */
  fill?: string;
  /** Point fill opacity. */
  fillOpacity?: number;
  indexCellSize?: number;
}

type ResolvedMarkerCollectionOptions = LayerOptions &
  Required<Omit<MarkerCollectionOptions, "marker" | keyof LayerOptions | keyof RemovedPointStyleAliases>> & {
    marker: MarkerOptions;
  };

/**
 * Large point sets as markers without mounting 50k DOM nodes.
 * Auto path uses WebGL above `webglThreshold`; DOM path viewport-culls;
 * SVG keeps real addressable DOM nodes with one shared style/transform;
 * hybrid keeps a bounded HTML icon layer over a WebGL remainder.
 */
export class MarkerCollection extends Layer<ResolvedMarkerCollectionOptions> {
  readonly index: SpatialGridIndex<{ i: number }, number>;
  private _points: LatLngLike[] = [];
  private _markers = new Map<number, Marker>();
  private _markerPool: Marker[] = [];
  private _domContainer: HTMLDivElement | null = null;
  private _svg: SVGSVGElement | null = null;
  private _svgGroup: SVGGElement | null = null;
  private _svgUses = new Map<number, SVGCircleElement>();
  private _selected = new Set<number>();
  private _webgl: WebGLPointLayer | null = null;
  private _active: "dom" | "svg" | "webgl" | "hybrid" = "dom";
  private _paintedZoom = Number.NaN;
  private _paintedOriginX = 0;
  private _paintedOriginY = 0;
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _schedule: () => void;
  private readonly _onView = (): void => this.#scheduleViewLayout();

  constructor(points: Iterable<LatLngLike> = [], options: MarkerCollectionOptions = {}) {
    rejectStyleAliases(options, "point");
    validateMarkerOptions(options.marker ?? {});
    const fill = options.fill ?? "#0f766e";
    const fillOpacity = options.fillOpacity ?? 0.88;
    const markerOpts: MarkerOptions = {
      keyboard: false,
      interactive: false,
      ...(options.marker?.icon !== undefined || options.marker?.content !== undefined ? {} : {
        shape: "dot" as const,
        size: options.pointSize ?? 8,
        strokeWidth: 0,
        color: fill
      }),
      ...(options.marker ?? {})
    } as MarkerOptions;
    super({
      pane: "overlay",
      renderer: "auto",
      webglThreshold: 2500,
      domLimit: 500,
      htmlButtonLimit: 0,
      buttonCellSize: Math.max(48, (options.pointSize ?? 8) * 12),
      iconMinZoom: Number.POSITIVE_INFINITY,
      viewportCull: true,
      pointSize: 8,
      indexCellSize: 1,
      ...options,
      fill,
      fillOpacity,
      marker: markerOpts
    });
    this.writableOptions.webglThreshold = Math.max(1, Math.floor(this.options.webglThreshold));
    this.writableOptions.domLimit = Math.max(0, Math.floor(this.options.domLimit));
    this.writableOptions.htmlButtonLimit = Math.max(0, Math.floor(this.options.htmlButtonLimit));
    this.writableOptions.buttonCellSize = Math.max(0, Number(this.options.buttonCellSize) || 0);
    const iconMinZoom = Number(this.options.iconMinZoom);
    this.writableOptions.iconMinZoom = Number.isFinite(iconMinZoom) ? iconMinZoom : Number.POSITIVE_INFINITY;
    this.index = new SpatialGridIndex(this.options.indexCellSize);
    this._schedule = rafThrottle(() => this.redraw());
    this.setLatLngs(points);
  }

  get size(): number {
    return this._points.length;
  }

  get renderer(): "dom" | "svg" | "webgl" | "hybrid" {
    return this._active;
  }

  /** Current real DOM node for an indexed point, or null in pure WebGL mode. */
  getElement(index: number): HTMLElement | SVGCircleElement | null {
    return this._markers.get(index)?.el ?? this._svgUses.get(index) ?? null;
  }

  /** Keep user-selected visible objects as full HTML buttons ahead of the automatic spatial budget. */
  setSelected(indices: Iterable<number>): this {
    this._selected.clear();
    for (const index of indices) {
      if (Number.isInteger(index) && this.index.has(index)) this._selected.add(index);
    }
    if (this.map && this._active === "svg") this.redraw();
    return this;
  }

  /** Add or remove one object from the user-selected HTML-button set. */
  setPointSelected(index: number, selected = true): this {
    if (selected && this.index.has(index)) this._selected.add(index);
    else this._selected.delete(index);
    if (this.map && this._active === "svg") this.redraw();
    return this;
  }

  setLatLngs(points: Iterable<LatLngLike>): this {
    this._points = [...points];
    this._selected.clear();
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
    const pane = map.getPane("marker");
    if (!pane) throw new Error("Orihon marker pane not found");
    this._domContainer = createEl("div", "oh-marker-collection", pane);
    map.on("moveend", this._onView);
    map.on("zoomend", this._onView);
    map.on("resize", this._onView);
    this.redraw();
  }

  override onRemove(): void {
    this.map?.off("moveend", this._onView);
    this.map?.off("zoomend", this._onView);
    this.map?.off("resize", this._onView);
    this.#clearSettleTimer();
    this.#clearRendered();
    this._domContainer?.remove();
    this._domContainer = null;
    super.onRemove();
  }

  override wantsFrameRender(): boolean {
    return this._active !== "webgl" && Boolean(this._domContainer);
  }

  override render(): void {
    if (!this.map || this._active === "webgl" || !Number.isFinite(this._paintedZoom)) return;
    const transform = cameraWarpCss(
      { x: this._paintedOriginX, y: this._paintedOriginY },
      this._paintedZoom,
      this.map.pixelOrigin,
      this.map.zoom
    );
    if (this._domContainer) this._domContainer.style.transform = transform;
  }

  redraw(): this {
    const map = this.map;
    if (!map) return this;
    const renderer = this.#resolveRenderer();
    this._active = renderer;

    if (renderer === "webgl") {
      this.#clearDomMarkers();
      this.#clearSvgMarkers();
      this.#syncWebgl();
      return this;
    }

    this._paintedZoom = map.zoom;
    this._paintedOriginX = map.pixelOrigin.x;
    this._paintedOriginY = map.pixelOrigin.y;
    if (renderer === "svg") {
      this.#clearWebgl();
      if (this._domContainer) this._domContainer.style.transform = "";
      const buttonIds = this.#syncSvgMarkers();
      this.#syncDomMarkerIds(buttonIds);
      return this;
    }

    this.#clearSvgMarkers();
    if (this._domContainer) this._domContainer.style.transform = "";
    const domIds = this.#syncDomMarkers(renderer === "hybrid" ? this.options.domLimit : Number.POSITIVE_INFINITY);
    if (renderer === "hybrid") this.#syncWebgl(domIds);
    else this.#clearWebgl();
    return this;
  }

  #resolveRenderer(): "dom" | "svg" | "webgl" | "hybrid" {
    const mode = this.options.renderer;
    if (mode === "hybrid") return "hybrid";
    if (mode === "svg") return "svg";
    if (mode === "dom") return "dom";
    // Icon LOD: near zoom prefers DivIcon / Marker DOM over GPU dots.
    if (this.map && this.map.zoom >= this.options.iconMinZoom) return "dom";
    if (mode === "webgl") return "webgl";
    return this.index.size >= this.options.webglThreshold ? "webgl" : "dom";
  }

  #syncWebgl(excludedIds?: ReadonlySet<number>): void {
    if (!this.map) return;
    const pts: LatLngLike[] = [];
    for (const [id, record] of this.index.records) {
      if (excludedIds?.has(id)) continue;
      pts.push(record.position);
    }
    if (!pts.length) {
      this.#clearWebgl();
      return;
    }
    if (!this._webgl) {
      this._webgl = webglPointLayer(pts, {
        pointSize: this.options.pointSize,
        color: this.options.fill,
        opacity: this.options.fillOpacity,
        interactive: false,
        maxDpr: 1.5
      });
      this._webgl.addTo(this.map);
    } else {
      this._webgl.setData(pts);
    }
  }

  #syncDomMarkers(limit: number): Set<number> {
    if (!this.map) return new Set();
    const area = this.options.viewportCull
      ? bounds(this.map.getBounds()).pad(0.12)
      : null;

    const visible = new Set<number>();
    if (area) {
      for (const id of this.index.searchIds(area)) {
        if (visible.size >= limit) break;
        visible.add(id);
      }
    } else {
      for (const id of this.index.records.keys()) {
        if (visible.size >= limit) break;
        visible.add(id);
      }
    }

    this.#syncDomMarkerIds(visible);
    return visible;
  }

  #syncDomMarkerIds(visible: ReadonlySet<number>): void {
    for (const [id, marker] of this._markers) {
      if (visible.has(id)) continue;
      this._markers.delete(id);
      if (marker.el) marker.el.style.display = "none";
      this._markerPool.push(marker);
    }

    // Build new elements off-DOM and attach them atomically. Marker.onAdd()
    // normally appends to the live pane; doing that thousands of times forces
    // Chrome to repeatedly update style/layout state during the initial load.
    const fragment = typeof document.createDocumentFragment === "function"
      ? document.createDocumentFragment()
      : null;
    let createdCount = 0;
    for (const id of visible) {
      const existing = this._markers.get(id);
      if (existing) {
        if (existing.el) existing.el.style.display = "";
        existing.render();
        continue;
      }
      const record = this.index.records.get(id);
      if (!record) continue;
      const created = this._markerPool.pop() ?? new Marker(record.position, this.options.marker);
      if (created.map) {
        if (created.el) created.el.style.display = "";
        created.setLatLng(record.position);
      } else {
        // Collection markers are implementation details: keeping them out of
        // map.layers avoids 5k per-frame Layer.render() dispatches.
        created.onAdd(this.map as Orihon, fragment ?? undefined);
        if (!fragment && created.el && this._domContainer) this._domContainer.appendChild(created.el);
        created.render();
        createdCount++;
      }
      this._markers.set(id, created);
    }
    if (createdCount && fragment && this._domContainer) this._domContainer.appendChild(fragment);

    // Recycle a bounded DOM working set across viewport changes.
    const targetPool = this._active === "hybrid" ? this.options.domLimit * 2
      : this._active === "svg" ? this.options.htmlButtonLimit * 2
        : this.options.webglThreshold * 2;
    const poolLimit = Math.min(this.index.size, Math.max(256, targetPool));
    while (this._markerPool.length > poolLimit) this._markerPool.pop()?.onRemove();
  }

  #syncSvgMarkers(): Set<number> {
    const map = this.map!;
    this.#ensureSvg();
    const svg = this._svg!;
    const group = this._svgGroup!;
    svg.setAttribute("viewBox", `0 0 ${map.size.width} ${map.size.height}`);

    const area = this.options.viewportCull ? bounds(map.getBounds()).pad(0.12) : null;
    const visible = new Set(area ? this.index.searchIds(area) : this.index.records.keys());

    const buttonIds = new Set<number>();
    for (const id of this._selected) if (visible.has(id)) buttonIds.add(id);
    const limit = Math.max(buttonIds.size, this.options.htmlButtonLimit);
    const cellSize = this.options.buttonCellSize;
    const occupied = new Set<number>();
    if (cellSize) {
      for (const id of buttonIds) {
        const record = this.index.records.get(id);
        if (!record) continue;
        const point = map.latLngToLayerPoint(record.position);
        occupied.add(Math.floor(point.x / cellSize) * 65536 + Math.floor(point.y / cellSize));
      }
    }
    for (const id of visible) {
      if (buttonIds.size >= limit) break;
      if (buttonIds.has(id)) continue;
      if (cellSize) {
        const record = this.index.records.get(id);
        if (!record) continue;
        const point = map.latLngToLayerPoint(record.position);
        const cell = Math.floor(point.x / cellSize) * 65536 + Math.floor(point.y / cellSize);
        if (occupied.has(cell)) continue;
        occupied.add(cell);
      }
      buttonIds.add(id);
    }
    for (const id of buttonIds) visible.delete(id);

    for (const [id, use] of this._svgUses) {
      if (visible.has(id)) continue;
      this._svgUses.delete(id);
      use.remove();
    }

    const fragment = typeof document.createDocumentFragment === "function"
      ? document.createDocumentFragment()
      : null;
    for (const id of visible) {
      const record = this.index.records.get(id);
      if (!record) continue;
      const point = map.latLngToLayerPoint(record.position);
      let use = this._svgUses.get(id);
      if (!use) {
        use = createSvgEl("circle");
        use.setAttribute("r", String(this.options.pointSize / 2));
        (fragment ?? group).appendChild(use);
        this._svgUses.set(id, use);
      }
      use.setAttribute("cx", String(point.x));
      use.setAttribute("cy", String(point.y));
    }
    if (fragment) group.appendChild(fragment);
    return buttonIds;
  }

  #ensureSvg(): void {
    if (this._svg) return;
    if (!this._domContainer) throw new Error("Orihon marker collection container not found");
    const svg = createSvgEl("svg");
    svg.classList.add("oh-svg-marker-collection");
    const group = createSvgEl("g", svg);
    group.setAttribute("fill", this.options.fill);
    group.setAttribute("fill-opacity", String(this.options.fillOpacity));
    this._domContainer.appendChild(svg);
    this._svg = svg;
    this._svgGroup = group;
  }

  #clearDomMarkers(): void {
    for (const marker of this._markers.values()) marker.onRemove();
    this._markers.clear();
    for (const marker of this._markerPool) marker.onRemove();
    this._markerPool.length = 0;
  }

  #clearSvgMarkers(): void {
    this._svg?.remove();
    this._svg = null;
    this._svgGroup = null;
    this._svgUses.clear();
  }

  #clearWebgl(): void {
    if (this._webgl) {
      this._webgl.remove();
      this._webgl = null;
    }
  }

  #clearRendered(): void {
    this.#clearDomMarkers();
    this.#clearSvgMarkers();
    this.#clearWebgl();
    this._active = "dom";
  }

  #scheduleViewLayout(): void {
    if (this._active === "webgl") {
      this._schedule();
      return;
    }
    // Cheaply warp the last exact layout on every camera frame. DOM markers
    // are reprojected and viewport-culled once after camera settle.
    this.render();
    this.#clearSettleTimer();
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      this.redraw();
    }, 120);
  }

  #clearSettleTimer(): void {
    if (this._settleTimer == null) return;
    clearTimeout(this._settleTimer);
    this._settleTimer = null;
  }
}

export function markerCollection(
  points?: Iterable<LatLngLike>,
  options?: MarkerCollectionOptions
): MarkerCollection {
  return new MarkerCollection(points, options);
}
