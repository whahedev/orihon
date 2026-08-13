import { Evented, type OrihonEvent, type EventHandler } from "../events.js";
import { CRSCompatibilityError } from "../crs.js";
import { rafThrottle } from "../dom.js";
import { ClusterCanvasLayer, clusterCanvasLayer } from "../layers/cluster-canvas-layer.js";
import { DivIcon, type MarkerIcon } from "../layers/icon.js";
import { Marker, type MarkerOptions } from "../layers/marker.js";
import { Polyline, polyline } from "../layers/vector.js";
import { WebGLPointLayer, webglPointLayer } from "../layers/webgl-point-layer.js";
import {
  LatLng,
  Point,
  latLng,
  latLngBounds,
  type LatLngBoundsLike,
  type LatLngLike,
  type PointLike
} from "../geo.js";
import type { Orihon } from "../map.js";
import {
  Popup,
  type OverlayContent,
  type OverlayContentContext,
  type OverlayRenderable,
  type PopupOptions
} from "../overlays/div-overlay.js";
import {
  buildClusterIndex,
  buildGreedyClusterLayout,
  collectClusterLeaves,
  queryClusterLayout,
  type ClusterIndex,
  type ClusterLayoutResult
} from "./cluster-layout.js";
import { GeometryWorkerPool, geometryWorkerPool } from "./geometry-worker.js";
import { SpatialGridIndex, type SpatialRecord } from "./spatial-grid-index.js";
import type { QueryHit, ResolvedQueryOptions } from "../layer.js";

let objectId = 0;

export type ObjectId = string | number;

export interface ManagedObject {
  id?: ObjectId;
  coordinates?: LatLngLike;
  geometry?: { coordinates?: number[] };
  properties?: { title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type ClusterRenderer = "dom" | "webgl" | "auto";

/** Fixed category / interaction palette for WebGL singles (RGBA 0..1). */
export const OBJECT_MANAGER_PALETTE = {
  alpha: [15 / 255, 118 / 255, 110 / 255, 0.88] as const,
  beta: [37 / 255, 99 / 255, 235 / 255, 0.88] as const,
  gamma: [202 / 255, 138 / 255, 4 / 255, 0.88] as const,
  alert: [220 / 255, 38 / 255, 38 / 255, 0.92] as const,
  selected: [124 / 255, 58 / 255, 237 / 255, 0.95] as const,
  hover: [245 / 255, 158 / 255, 11 / 255, 0.95] as const
};

export interface ObjectManagerOptions {
  minZoom?: number;
  marker?: MarkerOptions;
  clusterize?: boolean;
  /** When true (default), WebGL singles use category/alert/selected/hover palette colors. */
  styleByCategory?: boolean;
  /**
   * Cluster radius in CSS/world pixels at the clustered zoom (Leaflet-style).
   * Kept name `clusterGridSize` for compatibility; was formerly a grid cell size.
   * Default 50. Clamped to ≥ 20.
   */
  clusterGridSize?: number;
  clusterMinPoints?: number;
  clusterMaxZoom?: number;
  clusterZoomOnClick?: boolean;
  spiderfyOnMaxZoom?: boolean;
  spiderfyDistanceMultiplier?: number;
  zoomToBoundsOnClick?: boolean;
  indexCellSize?: number;
  /**
   * Custom cluster badge. Default: count label with size/color tiers
   * (`sm` < 10, `md` < 100, `lg` ≥ 100) — similar to Leaflet.markercluster.
   */
  clusterIcon?: ClusterIconFactory | null;
  clusterClassName?: string;
  clusterTitle?: (count: number, ids: ObjectId[]) => string;
  clusterAriaLabel?: (count: number, ids: ObjectId[]) => string;
  /**
   * Cluster / mass-point drawing backend.
   * - `dom` — Marker/DivIcon
   * - `webgl` — GPU points for unclustered objects; canvas cluster badges when clustering
   * - `auto` — webgl when indexed objects ≥ `webglThreshold` (with or without clustering)
   */
  clusterRenderer?: ClusterRenderer;
  /** Object count at which `auto` switches to WebGL. Default 2000. */
  webglThreshold?: number;
  /**
   * Offload first/zoom cluster layout to a Web Worker.
   * - `true` / `false` — force
   * - `auto` — worker when indexed objects ≥ `layoutWorkerThreshold`
   */
  layoutWorker?: boolean | "auto";
  /** Default 5000. */
  layoutWorkerThreshold?: number;
  /** Stop `add()` once this many objects are stored. `0` / unset = unlimited. */
  maxObjects?: number;
}

export type ClusterIconFactory = (count: number, ids: ObjectId[]) => MarkerIcon;

export type ObjectFilter = (object: ManagedObject, id: ObjectId) => boolean;

export interface ObjectPopupContext extends OverlayContentContext {
  manager: ObjectManager;
  object: ManagedObject;
  objectId: ObjectId;
}

export interface ClusterPopupContext extends OverlayContentContext {
  manager: ObjectManager;
  clusterId: string;
  objectIds: ObjectId[];
  objects: ManagedObject[];
}

export type ObjectPopupContent = OverlayContent | ((
  object: ManagedObject,
  id: ObjectId,
  context: ObjectPopupContext
) => OverlayRenderable | Promise<OverlayRenderable>);

export type ClusterPopupContent = OverlayContent | ((
  objects: ManagedObject[],
  ids: ObjectId[],
  context: ClusterPopupContext
) => OverlayRenderable | Promise<OverlayRenderable>);

export interface ObjectManagerStats {
  objects: number;
  indexedObjects: number;
  indexCells: number;
  visibleObjects: number;
  objectMarkers: number;
  clusters: number;
  renderedMarkers: number;
  renderer: "dom" | "webgl";
  layoutZoom: number | null;
}

interface ObjectManagerMap extends Evented {
  zoom: number;
  getBounds(): LatLngBoundsLike;
  latLngToLayerPoint(value: LatLngLike): Point;
  containerPointToLatLng(value: PointLike): LatLng;
  setView(center: LatLngLike, zoom: number): unknown;
  fitBounds(bounds: LatLngBoundsLike, options?: { padding?: number }): unknown;
  crs?: { code: "EPSG:3857" | "Simple" };
}

interface ClusterSpec {
  position: LatLng;
  ids: ObjectId[];
  count: number;
  nodeId: number;
}

interface LayoutCache {
  zoomBucket: number;
  clusters: Map<string, ClusterSpec>;
  singles: Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>;
}

type WebGLMeta =
  | { kind: "cluster"; id: string }
  | { kind: "object"; id: ObjectId };

type ResolvedObjectManagerOptions = Required<ObjectManagerOptions>;

export class ObjectManager extends Evented {
  readonly options: ResolvedObjectManagerOptions;
  readonly items = new Map<ObjectId, ManagedObject>();
  readonly markers = new Map<ObjectId, Marker>();
  readonly clusters = new Map<string, Marker>();
  readonly clusterMembers = new Map<string, ObjectId[]>();
  readonly index: SpatialGridIndex<ManagedObject, ObjectId>;
  map: ObjectManagerMap | null = null;
  filter: ObjectFilter | null = null;
  readonly _render: EventHandler;
  readonly _scheduleRender: () => void;
  private _visibleObjects = 0;
  private _popupBinding: { content: ObjectPopupContent; options?: PopupOptions } | null = null;
  private _clusterPopupBinding: { content: ClusterPopupContent; options?: PopupOptions } | null = null;
  private _activePopup: Popup | null = null;
  private _layout: LayoutCache | null = null;
  private _clusterIndex: ClusterIndex | null = null;
  private _layoutDirty = true;
  private _webglLayer: WebGLPointLayer | null = null;
  private _webglMeta: WebGLMeta[] = [];
  /** GPU slot index for each object id currently drawn in `_webglMeta`. */
  private _webglIdToIndex = new Map<ObjectId, number>();
  /** Full (unfiltered) GPU pack — filter/live compact without re-encoding mercator. */
  private _webglPack: {
    latlng: Float32Array;
    merc64: Float64Array;
    colors: Float32Array | null;
    meta: WebGLMeta[];
    idToIndex: Map<ObjectId, number>;
    singles: Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>;
  } | null = null;
  private _webglSyncedZoom: number | null = null;
  private _selectedId: ObjectId | null = null;
  private _hoveredId: ObjectId | null = null;
  private _clusterCanvas: ClusterCanvasLayer | null = null;
  private _canvasClusterCount = 0;
  private _activeRenderer: "dom" | "webgl" = "dom";
  private _workerPool: GeometryWorkerPool;
  private _layoutGeneration = 0;
  private _layoutPromise: Promise<void> | null = null;
  private _clusterSyncZoom: number | null = null;
  private _clusterSyncGeneration = -1;
  private _clusterPool: Marker[] = [];
  private readonly _clusterMarkerKey = new WeakMap<Marker, string>();
  /** Keep all badges mounted when total clusters ≤ this (avoids pan add/remove churn). */
  private _clusterDomBudget = 4000;
  /** Cached single-zoom greedy results while the hierarchy index is still building. */
  private _greedyCache = new Map<number, ClusterLayoutResult>();
  private _pendingGreedyZoom: number | null = null;
  private _greedyRaf = 0;
  /** Above this size, never run sync greedy on every zoomend (stale+coalesce instead). */
  private _greedyZoomInlineLimit = 2500;
  private _layoutIds: ObjectId[] = [];
  private _layoutCoords = new Float64Array(0);
  private _layoutPacked = 0;
  private _layoutPackDirty = true;
  private _spiderMarkers: Marker[] = [];
  private _spiderLegs: Polyline[] = [];
  private _spiderClusterId: string | null = null;
  private readonly _unspiderfyOnMapClick = (): void => { this.unspiderfy(); };

  constructor(options: ObjectManagerOptions = {}) {
    super();
    this.options = {
      minZoom: 0,
      marker: {},
      clusterize: false,
      clusterGridSize: 50,
      clusterMinPoints: 2,
      clusterMaxZoom: 16,
      clusterZoomOnClick: true,
      spiderfyOnMaxZoom: true,
      spiderfyDistanceMultiplier: 1,
      zoomToBoundsOnClick: true,
      indexCellSize: 1,
      clusterIcon: null,
      clusterClassName: "oh-cluster-marker",
      clusterTitle: (count) => `${count} objects`,
      clusterAriaLabel: (count) => `${count} map objects`,
      clusterRenderer: "auto",
      webglThreshold: 2000,
      layoutWorker: "auto",
      layoutWorkerThreshold: 5000,
      styleByCategory: true,
      maxObjects: 0,
      ...options
    };
    this.options.clusterGridSize = Math.max(20, Number(this.options.clusterGridSize));
    this.options.clusterMinPoints = Math.max(2, Math.floor(this.options.clusterMinPoints));
    this.options.webglThreshold = Math.max(1, Math.floor(this.options.webglThreshold));
    this.options.layoutWorkerThreshold = Math.max(1, Math.floor(this.options.layoutWorkerThreshold));
    this.options.maxObjects = Math.max(0, Math.floor(Number(this.options.maxObjects) || 0));
    this.options.spiderfyDistanceMultiplier = Math.max(0.25, Number(this.options.spiderfyDistanceMultiplier) || 1);
    this.index = new SpatialGridIndex<ManagedObject, ObjectId>(this.options.indexCellSize);
    this._render = () => this.render();
    this._scheduleRender = rafThrottle(() => this.render());
    this._workerPool = geometryWorkerPool();
  }

  addTo(map: ObjectManagerMap): this {
    if (this.map === map) return this;
    this.remove();
    if (this.options.clusterRenderer === "webgl" && map.crs?.code === "Simple") {
      throw new CRSCompatibilityError();
    }
    this.map = map;
    map.on("moveend", this._scheduleRender);
    map.on("zoomend", this._scheduleRender);
    map.on("resize", this._scheduleRender);
    map.on("click", this._unspiderfyOnMapClick);
    this.render();
    return this;
  }

  remove(): this;
  remove(ids: ObjectId | ObjectId[]): this;
  remove(ids?: ObjectId | ObjectId[]): this {
    if (ids !== undefined) return this.removeObjects(ids);
    if (!this.map) return this;
    this.map.off("moveend", this._scheduleRender);
    this.map.off("zoomend", this._scheduleRender);
    this.map.off("resize", this._scheduleRender);
    this.map.off("click", this._unspiderfyOnMapClick);
    this.unspiderfy();
    this.#clearRendered();
    this.closePopup();
    this.map = null;
    return this;
  }

  destroy(): this {
    this.remove();
    this.clear();
    this.#drainClusterPool();
    this._layoutGeneration++;
    // Shared geometry worker pool stays alive across managers (avoids recompiling the worker blob).
    this.off();
    return this;
  }

  add(features: ManagedObject | ManagedObject[]): this {
    const list = Array.isArray(features) ? features : [features];
    const cap = this.options.maxObjects;
    for (const item of list) {
      if (cap > 0 && this.items.size >= cap && (item.id == null || !this.items.has(item.id))) break;
      const id = item.id ?? globalThis.crypto?.randomUUID?.() ?? `oh-object-${++objectId}`;
      this.#dropRenderedObject(id);
      this.items.set(id, item);
      this.index.delete(id);
      const position = this.#objectPosition(item);
      if (position) this.index.set(id, position, item);
    }
    this.#invalidateLayout();
    this._scheduleRender();
    return this;
  }

  /**
   * In-place update of existing objects (coordinates / properties).
   * On the WebGL non-cluster path this patches GPU buffers instead of a full layout rebuild —
   * critical for realtime stress at 100k–1M.
   */
  update(features: ManagedObject | ManagedObject[]): this {
    const list = Array.isArray(features) ? features : [features];
    if (this.#canPatchWebgl()) {
      const touched: ObjectId[] = [];
      for (const item of list) {
        const id = item.id;
        if (id == null) continue;
        this.items.set(id, item);
        const position = this.#objectPosition(item);
        if (!position) continue;
        this.index.set(id, position, item);
        const slot = this._webglIdToIndex.get(id);
        if (slot == null) continue;
        const ll = latLng(position);
        this._webglLayer!.patchPoint(slot, ll.lat, ll.lng);
        const record = this.index.records.get(id);
        if (record && this._layout) this._layout.singles.set(id, record);
        const packSlot = this._webglPack?.idToIndex.get(id);
        if (this._webglPack && packSlot != null && record) {
          this._webglPack.latlng[packSlot * 2] = ll.lat;
          this._webglPack.latlng[packSlot * 2 + 1] = ll.lng;
          const clamped = Math.max(-85.05112878, Math.min(85.05112878, ll.lat));
          const sin = Math.sin((clamped * Math.PI) / 180);
          this._webglPack.merc64[packSlot * 2] = (ll.lng + 180) / 360;
          this._webglPack.merc64[packSlot * 2 + 1] = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
          this._webglPack.singles.set(id, record);
        }
        touched.push(id);
      }
      if (this.options.styleByCategory && touched.length) this.#patchWebglColors(touched);
      this._webglLayer!.render();
      return this;
    }
    return this.add(list);
  }

  removeObjects(ids: ObjectId | ObjectId[]): this {
    this.unspiderfy();
    this.closePopup();
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      this.items.delete(id);
      this.index.delete(id);
      this.#dropRenderedObject(id);
    }
    this.#invalidateLayout();
    this._scheduleRender();
    return this;
  }

  getObject(id: ObjectId): ManagedObject | undefined { return this.items.get(id); }

  getObjects(): ManagedObject[] { return [...this.items.values()]; }

  setFilter(filter: ObjectFilter | null): this {
    this.unspiderfy();
    this.filter = filter;
    // WebGL + no clusters: rebuild the GPU list from the spatial index without greedy layout.
    if (this.map && this.#shouldUseWebgl() && !this.options.clusterize) {
      this.#fastWebglFilterSync();
      return this;
    }
    this.#invalidateLayout();
    this._scheduleRender();
    return this;
  }

  getSelectedId(): ObjectId | null {
    return this._selectedId;
  }

  setSelected(id: ObjectId | null): this {
    const next = id == null ? null : id;
    if (this._selectedId === next) return this;
    const prev = this._selectedId;
    this._selectedId = next;
    if (this.#canPatchWebgl() && this.options.styleByCategory) {
      const touched: ObjectId[] = [];
      if (prev != null) touched.push(prev);
      if (next != null) touched.push(next);
      this.#patchWebglColors(touched);
      this._webglLayer!.render();
    } else {
      this.#refreshWebglColors();
      this._scheduleRender();
    }
    for (const [markerId, marker] of this.markers) {
      const object = this.items.get(markerId);
      if (object) this.#paintDomMarker(marker, markerId, object);
    }
    return this;
  }

  getHoveredId(): ObjectId | null {
    return this._hoveredId;
  }

  setHovered(id: ObjectId | null): this {
    const next = id == null ? null : id;
    if (this._hoveredId === next) return this;
    const prev = this._hoveredId;
    this._hoveredId = next;
    if (this.#canPatchWebgl() && this.options.styleByCategory) {
      const touched: ObjectId[] = [];
      if (prev != null) touched.push(prev);
      if (next != null) touched.push(next);
      this.#patchWebglColors(touched);
      this._webglLayer!.render();
    } else {
      this.#refreshWebglColors();
    }
    for (const [markerId, marker] of this.markers) {
      const object = this.items.get(markerId);
      if (object) this.#paintDomMarker(marker, markerId, object);
    }
    return this;
  }

  bindPopup(content: ObjectPopupContent, options?: PopupOptions): this {
    this._popupBinding = { content, options };
    return this;
  }

  unbindPopup(): this {
    this._popupBinding = null;
    this.closePopup();
    return this;
  }

  bindClusterPopup(content: ClusterPopupContent, options?: PopupOptions): this {
    this._clusterPopupBinding = { content, options };
    return this;
  }

  unbindClusterPopup(): this {
    this._clusterPopupBinding = null;
    this.closePopup();
    return this;
  }

  openPopup(id: ObjectId): this {
    const object = this.items.get(id);
    const position = object ? this.#objectPosition(object) : null;
    if (object && position && this._popupBinding) {
      this.#openObjectPopup(id, object, position);
    }
    return this;
  }

  closePopup(): this {
    this._activePopup?.close();
    this._activePopup = null;
    return this;
  }

  hasOpenPopup(): boolean {
    return Boolean(this._activePopup);
  }

  setClusterize(enabled: boolean): this {
    if (this.options.clusterize === Boolean(enabled)) return this;
    this.options.clusterize = Boolean(enabled);
    this.unspiderfy();
    this.#invalidateLayout();
    this.#clearRendered();
    this._scheduleRender();
    return this;
  }

  setClusterGridSize(size: number): this {
    const next = Math.max(20, Number(size));
    if (!Number.isFinite(next)) throw new TypeError("clusterGridSize must be a finite number");
    if (this.options.clusterGridSize === next) return this;
    this.options.clusterGridSize = next;
    this.unspiderfy();
    this.#invalidateLayout();
    this.#clearRendered();
    this._scheduleRender();
    return this;
  }

  setClusterRenderer(renderer: ClusterRenderer): this {
    if (this.options.clusterRenderer === renderer) return this;
    this.options.clusterRenderer = renderer;
    this.unspiderfy();
    this.#clearRendered();
    this._scheduleRender();
    return this;
  }

  clear(): this {
    this.unspiderfy();
    this.closePopup();
    this.#clearRendered();
    this.items.clear();
    this.index.clear();
    this._visibleObjects = 0;
    this.#invalidateLayout();
    return this;
  }

  getStats(): ObjectManagerStats {
    const webglCount = this._webglLayer ? this._webglMeta.length : 0;
    const clusterCount = this._clusterCanvas ? this._canvasClusterCount : this.clusters.size;
    return {
      objects: this.items.size,
      indexedObjects: this.index.size,
      indexCells: this.index.cellCount,
      visibleObjects: this._visibleObjects,
      objectMarkers: this._activeRenderer === "webgl" ? webglCount : this.markers.size,
      clusters: clusterCount,
      renderedMarkers: (this._activeRenderer === "webgl" ? webglCount : this.markers.size) + clusterCount,
      renderer: this._activeRenderer,
      layoutZoom: this._layout?.zoomBucket ?? null
    };
  }

  queryHit(point: Point, options: ResolvedQueryOptions): QueryHit | QueryHit[] | null {
    const hits: QueryHit[] = [];
    const clusterHit = this._clusterCanvas?.queryHit(point, options);
    if (clusterHit) {
      const clusterId = String(clusterHit.id);
      hits.push({ ...clusterHit, source: "cluster", feature: this.#clusterMemberIds(clusterId) });
    }
    const webglHit = this._webglLayer?.queryHit(point, options);
    if (webglHit && webglHit.index != null) {
      const meta = this._webglMeta[webglHit.index];
      if (meta?.kind === "object") hits.push({
        ...webglHit,
        source: "object",
        id: meta.id,
        feature: this.items.get(meta.id)
      });
    }
    for (const [id, marker] of [...this.markers].reverse()) {
      const hit = marker.queryHit(point, options);
      if (hit) hits.push({ ...hit, source: "object", id, feature: this.items.get(id) });
    }
    for (const [id, marker] of [...this.clusters].reverse()) {
      const hit = marker.queryHit(point, options);
      if (hit) hits.push({ ...hit, source: "cluster", id, feature: this.#clusterMemberIds(id) });
    }
    if (!hits.length) return null;
    return options.limit === 1 ? hits[0] : hits.slice(0, options.limit);
  }

  spiderfyCluster(clusterId: string): this {
    if (!this.map || !this.options.spiderfyOnMaxZoom) return this;
    const ids = [...this.#clusterMemberIds(clusterId)];
    const spec = this._layout?.clusters.get(clusterId);
    const marker = this.clusters.get(clusterId);
    const center = spec?.position ?? marker?.getLatLng();
    if (!center || ids.length < 2) return this;
    this.unspiderfy();
    this._spiderClusterId = clusterId;
    const centerPoint = this.map.latLngToLayerPoint(center);
    const multiplier = this.options.spiderfyDistanceMultiplier;
    const count = ids.length;
    ids.forEach((id, index) => {
      const object = this.items.get(id);
      if (!object) return;
      let angle: number;
      let radius: number;
      if (count <= 8) {
        angle = index * Math.PI * 2 / count - Math.PI / 2;
        radius = 38 * multiplier;
      } else {
        angle = index * 0.65 - Math.PI / 2;
        radius = (26 + index * 5) * multiplier;
      }
      const position = this.map!.containerPointToLatLng([
        centerPoint.x + Math.cos(angle) * radius,
        centerPoint.y + Math.sin(angle) * radius
      ]);
      const leg = polyline([center, position], {
        pane: "overlay",
        stroke: "#64748b",
        strokeWidth: 1.5,
        strokeOpacity: 0.75,
        interactive: false
      });
      leg.addTo(this.map as Orihon);
      this._spiderLegs.push(leg);
      const spider = new Marker(position, {
        ...this.options.marker,
        title: object.properties?.title || "",
        className: `${this.options.marker.className ?? ""} oh-spider-marker`.trim()
      });
      spider.on("click", (event) => this.#objectClickAt(id, spider, event));
      spider.addTo(this.map as Orihon);
      this._spiderMarkers.push(spider);
    });
    this.emit("spiderfy", { clusterId, objectIds: ids });
    return this;
  }

  unspiderfy(): this {
    if (!this._spiderClusterId && !this._spiderMarkers.length && !this._spiderLegs.length) return this;
    const clusterId = this._spiderClusterId;
    for (const marker of this._spiderMarkers) marker.remove();
    for (const leg of this._spiderLegs) leg.remove();
    this._spiderMarkers = [];
    this._spiderLegs = [];
    this._spiderClusterId = null;
    this.emit("unspiderfy", { clusterId });
    return this;
  }

  render(): void {
    const map = this.map;
    if (!map) return;
    if (map.zoom < this.options.minZoom) {
      this._visibleObjects = 0;
      this.#clearRendered();
      this.emit("render", { stats: this.getStats() });
      return;
    }

    const layout = this.#ensureLayout(map);
    const useWebgl = this.#shouldUseWebgl();
    const useCanvasClusters = this.#useCanvasClusters();
    this._activeRenderer = useWebgl ? "webgl" : "dom";

    const bounds = latLngBounds(map.getBounds()).pad(0.15);

    if (useWebgl) {
      // GPU points for singles; optional canvas/DOM cluster badges when clusterize is on.
      this.#clearObjectMarkers();
      if (this.options.clusterize) {
        const clusterSpecs = this.#pickClusterSpecs(layout, bounds);
        this._visibleObjects = this.#countVisibleFromLayout(layout, bounds, clusterSpecs);
        this.#syncWebgl(layout);
        if (useCanvasClusters) {
          this.#clearDomClusters();
          this.#syncCanvasClusters(clusterSpecs);
        } else {
          this.#clearClusterCanvas();
          this.#syncClusters(clusterSpecs, layout);
        }
      } else {
        // Non-cluster WebGL: every drawn single is "visible" for stats — skip O(N) bounds walk.
        this._visibleObjects = layout.singles.size;
        this.#clearClusterCanvas();
        this.#clearDomClusters();
        this.#syncWebgl(layout);
      }
      this.emit("render", { stats: this.getStats() });
      return;
    }

    const visibleIds = new Set(
      this.index.searchIds(bounds, (id, value) => !this.filter || this.filter(value, id))
    );
    this._visibleObjects = visibleIds.size;
    const clusterSpecs = this.#pickClusterSpecs(layout, bounds, visibleIds);

    const markerRecords = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
    for (const [id, record] of layout.singles) {
      if (visibleIds.has(id)) markerRecords.set(id, record);
    }

    this.#clearWebgl();
    this.#clearClusterCanvas();
    this.#syncObjectMarkers(markerRecords);
    this.#syncClusters(clusterSpecs, layout);
    this.emit("render", { stats: this.getStats() });
  }

  #shouldUseWebgl(): boolean {
    if (this.map?.crs?.code === "Simple") return false;
    const mode = this.options.clusterRenderer;
    if (mode === "webgl") return true;
    if (mode === "dom") return false;
    // Auto: GPU for large sets even without clustering (mass markers).
    return this.index.size >= this.options.webglThreshold;
  }

  /** Canvas badges when WebGL path is active and no custom clusterIcon (API keeps DOM). */
  #useCanvasClusters(): boolean {
    return this.#shouldUseWebgl() && this.options.clusterize && !this.options.clusterIcon;
  }

  #countVisibleFromLayout(
    layout: LayoutCache,
    bounds: ReturnType<typeof latLngBounds>,
    clusterSpecs: Map<string, ClusterSpec>
  ): number {
    let total = 0;
    for (const spec of clusterSpecs.values()) total += spec.count || spec.ids.length;
    for (const record of layout.singles.values()) {
      if (bounds.contains(record.position)) total += 1;
    }
    return total;
  }

  /**
   * Paint clusters for the current (or given) zoom quickly, then build the zoom hierarchy
   * in the background (worker when enabled). Zoom changes use the index once it is ready.
   */
  async prepareLayout(zoom?: number): Promise<this> {
    // Flat WebGL mass markers: skip greedy singles allocation (huge win at 1M).
    if (this.#shouldUseWebgl() && !this.options.clusterize) {
      const zoomBucket = Math.floor(zoom ?? this.map?.zoom ?? 0);
      this.#buildFlatLayout(zoomBucket);
      if (this.map) {
        this.render();
      }
      return this;
    }

    const zoomBucket = Math.floor(zoom ?? this.map?.zoom ?? 0);
    const generation = ++this._layoutGeneration;
    const request = this.#collectLayoutRequest(zoomBucket);

    // Fast O(n) first paint — do not block on the full hierarchy.
    const greedy = buildGreedyClusterLayout(request);
    this._greedyCache.set(zoomBucket, greedy);
    this.#applyLayoutResult(zoomBucket, greedy);
    if (this.map) this.render();
    if (generation !== this._layoutGeneration) return this;

    if (!request.clusterize || request.ids.length === 0) {
      this._clusterIndex = null;
      return this;
    }

    // Small sets: finish hierarchy inline so tests/popups see a stable tree immediately.
    if (request.ids.length < this._greedyZoomInlineLimit) {
      const index = buildClusterIndex(request);
      if (generation !== this._layoutGeneration) return this;
      this._clusterIndex = index;
      this._greedyCache.clear();
      this.#applyLayoutResult(
        zoomBucket,
        queryClusterLayout(index, zoomBucket, this.options.clusterMinPoints, { expandLeaves: false })
      );
      if (this.map) this.render();
      return this;
    }

    // Defer hierarchy so Worker blob compile / heavy sync build never blocks first paint.
    const task = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        this.#buildHierarchy(request, generation, zoomBucket).then(resolve, reject);
      }, 0);
    });
    this._layoutPromise = task.finally(() => {
      if (this._layoutPromise === task) this._layoutPromise = null;
    });
    return this;
  }

  async #buildHierarchy(
    request: {
      ids: ObjectId[];
      coords: Float64Array;
      zoomBucket: number;
      gridSize: number;
      minPoints: number;
      clusterize: boolean;
      clusterMaxZoom: number;
      simple?: boolean;
    },
    generation: number,
    zoomBucket: number
  ): Promise<void> {
    const index = this.#shouldUseLayoutWorker()
      ? await this._workerPool.clusterIndex(request)
      : await new Promise<ClusterIndex>((resolve) => {
          setTimeout(() => resolve(buildClusterIndex(request)), 0);
        });
    if (generation !== this._layoutGeneration) return;
    this._clusterIndex = index;
    this._greedyCache.clear();
    const z = Math.floor(this.map?.zoom ?? zoomBucket);
    // Apply on the next frame so hierarchy completion does not hitch the current rAF slice.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (generation !== this._layoutGeneration || this._clusterIndex !== index) return;
        const liveZoom = Math.floor(this.map?.zoom ?? z);
        this.#applyLayoutResult(
          liveZoom,
          queryClusterLayout(index, liveZoom, this.options.clusterMinPoints, { expandLeaves: false })
        );
        this._scheduleRender();
      });
      return;
    }
    this.#applyLayoutResult(
      z,
      queryClusterLayout(index, z, this.options.clusterMinPoints, { expandLeaves: false })
    );
    if (this.map) this.render();
  }

  #shouldUseLayoutWorker(): boolean {
    if (this.map?.crs?.code === "Simple") return false;
    const mode = this.options.layoutWorker;
    if (mode === true) return true;
    if (mode === false) return false;
    return this.index.size >= this.options.layoutWorkerThreshold;
  }

  #collectLayoutRequest(zoomBucket: number) {
    this.#syncLayoutPack();
    return {
      ids: this._layoutIds,
      coords: this._layoutCoords.subarray(0, this._layoutPacked * 2),
      zoomBucket,
      gridSize: this.options.clusterGridSize,
      minPoints: this.options.clusterMinPoints,
      clusterize: this.options.clusterize,
      clusterMaxZoom: this.options.clusterMaxZoom,
      simple: this.map?.crs?.code === "Simple"
    };
  }

  #syncLayoutPack(): void {
    if (!this._layoutPackDirty) return;
    const filter = this.filter;
    const need = this.index.size;
    if (this._layoutCoords.length < need * 2) this._layoutCoords = new Float64Array(Math.max(need * 2, 16));
    if (this._layoutIds.length < need) this._layoutIds.length = need;
    let packed = 0;
    for (const record of this.index.records.values()) {
      if (filter && !filter(record.value, record.id)) continue;
      this._layoutIds[packed] = record.id;
      this._layoutCoords[packed * 2] = record.position.lat;
      this._layoutCoords[packed * 2 + 1] = record.position.lng;
      packed++;
    }
    this._layoutIds.length = packed;
    this._layoutPacked = packed;
    this._layoutPackDirty = false;
  }

  #applyLayoutResult(zoomBucket: number, result: ClusterLayoutResult): void {
    const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
    const clusters = new Map<string, ClusterSpec>();

    for (const single of result.singles) {
      const value = this.items.get(single.id);
      if (!value) continue;
      singles.set(single.id, {
        id: single.id,
        position: latLng([single.lat, single.lng]),
        value
      });
    }
    for (const cluster of result.clusters) {
      clusters.set(cluster.key, {
        position: latLng([cluster.lat, cluster.lng]),
        ids: cluster.ids,
        count: cluster.count ?? cluster.ids.length,
        nodeId: cluster.nodeId ?? -1
      });
    }

    this._layout = { zoomBucket, clusters, singles };
    this._layoutDirty = false;
    this._webglSyncedZoom = null;
    // Drop cached leaf lists from the previous zoom/layout (keys are zoom-scoped;
    // greedy expansions must not survive into the hierarchy path).
    this.clusterMembers.clear();
  }

  #invalidateLayout(): void {
    this._clusterIndex = null;
    this._layoutDirty = true;
    this._webglSyncedZoom = null;
    this._webglPack = null;
    this._clusterSyncZoom = null;
    this._clusterSyncGeneration = -1;
    this._layoutGeneration++;
    this._layoutPromise = null;
    this._greedyCache.clear();
    this._pendingGreedyZoom = null;
    this._layoutPackDirty = true;
    if (this._greedyRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._greedyRaf);
      this._greedyRaf = 0;
    }
  }

  /** Coalesce expensive pre-hierarchy reclusters onto the latest zoom only. */
  #scheduleGreedyForZoom(zoomBucket: number): void {
    this._pendingGreedyZoom = zoomBucket;
    if (this._greedyRaf) return;
    const run = () => {
      this._greedyRaf = 0;
      const target = this._pendingGreedyZoom;
      this._pendingGreedyZoom = null;
      if (target == null || this._clusterIndex || this._layoutDirty) return;
      if (this._layout?.zoomBucket === target) return;
      const cached = this._greedyCache.get(target);
      if (cached) {
        this.#applyLayoutResult(target, cached);
        this._scheduleRender();
        return;
      }
      const request = this.#collectLayoutRequest(target);
      const result = buildGreedyClusterLayout(request);
      this.#rememberGreedy(target, result);
      this.#applyLayoutResult(target, result);
      this._scheduleRender();
    };
    if (typeof requestAnimationFrame === "function") {
      this._greedyRaf = requestAnimationFrame(run);
    } else {
      run();
    }
  }

  #rememberGreedy(zoomBucket: number, result: ClusterLayoutResult): void {
    this._greedyCache.set(zoomBucket, result);
    if (this._greedyCache.size <= 8) return;
    const oldest = this._greedyCache.keys().next().value;
    if (oldest != null) this._greedyCache.delete(oldest);
  }

  #pickClusterSpecs(
    layout: LayoutCache,
    bounds: ReturnType<typeof latLngBounds>,
    visibleIds?: Set<ObjectId>
  ): Map<string, ClusterSpec> {
    // World-stable keys: when the full set is modest, keep every badge mounted so pan
    // does not thrash DOM create/remove. Canvas path also benefits from drawing all
    // modest sets without per-pan churn of setClusters identity.
    if (layout.clusters.size <= this._clusterDomBudget) return layout.clusters;
    const clusterSpecs = new Map<string, ClusterSpec>();
    for (const [key, spec] of layout.clusters) {
      if (bounds.contains(spec.position)) {
        clusterSpecs.set(key, spec);
        continue;
      }
      // Member-id visibility only when leaves were already expanded.
      if (visibleIds && spec.ids.length && spec.ids.some((id) => visibleIds.has(id))) {
        clusterSpecs.set(key, spec);
      }
    }
    return clusterSpecs;
  }

  #ensureLayout(map: ObjectManagerMap): LayoutCache {
    const zoomBucket = Math.floor(map.zoom);

    // Non-cluster WebGL: flat layout from the spatial index (reuse records, no greedy alloc).
    if (this.#shouldUseWebgl() && !this.options.clusterize) {
      if (this._layoutDirty || !this._layout || this._layout.zoomBucket !== zoomBucket) {
        this.#buildFlatLayout(zoomBucket);
      }
      return this._layout!;
    }

    if (
      !this._layoutDirty &&
      this._layout &&
      this._layout.zoomBucket === zoomBucket
    ) {
      return this._layout;
    }

    // Zoom-only: reuse hierarchical index (no rebuild).
    if (!this._layoutDirty && this._clusterIndex) {
      this.#applyLayoutResult(
        zoomBucket,
        queryClusterLayout(this._clusterIndex, zoomBucket, this.options.clusterMinPoints, { expandLeaves: false })
      );
      return this._layout!;
    }

    // Pre-hierarchy zoom changes: never stall the frame with another full O(n) greedy pass
    // on large datasets. Show the last layout (or a cache hit) and coalesce a rebuild.
    if (!this._layoutDirty && this._layout && !this._clusterIndex) {
      const cached = this._greedyCache.get(zoomBucket);
      if (cached) {
        this.#applyLayoutResult(zoomBucket, cached);
        return this._layout!;
      }
      if (this.index.size >= this._greedyZoomInlineLimit) {
        this.#scheduleGreedyForZoom(zoomBucket);
        return this._layout;
      }
      const request = this.#collectLayoutRequest(zoomBucket);
      const result = buildGreedyClusterLayout(request);
      this.#rememberGreedy(zoomBucket, result);
      this.#applyLayoutResult(zoomBucket, result);
      return this._layout!;
    }

    // First paint / data change: one greedy pass, then hierarchy in the background.
    const request = this.#collectLayoutRequest(zoomBucket);
    const greedy = buildGreedyClusterLayout(request);
    this.#rememberGreedy(zoomBucket, greedy);
    this.#applyLayoutResult(zoomBucket, greedy);

    if (request.clusterize && request.ids.length > 0 && !this._layoutPromise) {
      if (request.ids.length < this._greedyZoomInlineLimit) {
        const index = buildClusterIndex(request);
        this._clusterIndex = index;
        this._greedyCache.clear();
        this.#applyLayoutResult(
          zoomBucket,
          queryClusterLayout(index, zoomBucket, this.options.clusterMinPoints, { expandLeaves: false })
        );
      } else {
        const generation = this._layoutGeneration;
        const task = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            this.#buildHierarchy(request, generation, zoomBucket).then(resolve, reject);
          }, 0);
        });
        this._layoutPromise = task.finally(() => {
          if (this._layoutPromise === task) this._layoutPromise = null;
        });
      }
    }

    return this._layout!;
  }

  #syncObjectMarkers(records: Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>): void {
    for (const [id, marker] of this.markers) {
      if (records.has(id)) continue;
      marker.remove();
      this.markers.delete(id);
    }
    for (const [id, record] of records) {
      const current = this.markers.get(id);
      if (current) {
        current.setLatLng(record.position);
        this.#paintDomMarker(current, id, record.value);
        continue;
      }
      const title = record.value.properties?.title || "";
      const created = new Marker(record.position, { ...this.options.marker, title });
      this.#paintDomMarker(created, id, record.value);
      created.on("click", (event) => {
        this.setSelected(id);
        const payload = {
          ...event,
          objectId: id,
          object: this.items.get(id),
          layer: created
        };
        this.emit("click", payload);
        const object = this.items.get(id);
        if (object && this._popupBinding) this.#openObjectPopup(id, object, created.getLatLng(), payload);
      });
      created.on("mouseover", () => {
        this.setHovered(id);
        this.emit("hover", { objectId: id, object: this.items.get(id) });
      });
      created.on("mouseout", () => {
        if (this._hoveredId === id) {
          this.setHovered(null);
          this.emit("hover", { objectId: null, object: null });
        }
      });
      created.addTo(this.map as Orihon);
      this.markers.set(id, created);
    }
  }

  #paintDomMarker(marker: Marker, id: ObjectId, object: ManagedObject): void {
    const el = marker.el;
    if (!el) return;
    const cat = String(object.properties?.category || "alpha");
    el.classList.toggle("oh-om-alpha", cat === "alpha");
    el.classList.toggle("oh-om-beta", cat === "beta");
    el.classList.toggle("oh-om-gamma", cat === "gamma");
    el.classList.toggle("oh-om-alert", Boolean(object.properties?.alert));
    el.classList.toggle("oh-om-selected", this._selectedId === id);
    el.classList.toggle("oh-om-hover", this._hoveredId === id);
  }

  #syncClusters(specs: Map<string, ClusterSpec>, layout: LayoutCache): void {
    const fullyMounted =
      specs === layout.clusters ||
      (layout.clusters.size <= this._clusterDomBudget && specs.size === layout.clusters.size);
    if (
      fullyMounted &&
      this._clusterSyncZoom === layout.zoomBucket &&
      this._clusterSyncGeneration === this._layoutGeneration &&
      this.clusters.size === specs.size
    ) {
      return;
    }

    for (const [key, marker] of this.clusters) {
      if (specs.has(key)) continue;
      this.clusters.delete(key);
      this.clusterMembers.delete(key);
      this.#releaseClusterMarker(marker);
    }

    for (const [key, spec] of specs) {
      const count = spec.count || spec.ids.length;
      const previous = this.clusterMembers.get(key);
      const previousCount = previous?.length ?? (this.clusters.has(key) ? count : undefined);
      if (spec.ids.length) this.clusterMembers.set(key, spec.ids);
      else this.clusterMembers.delete(key);
      const current = this.clusters.get(key);
      if (current) {
        const pos = current.getLatLng();
        if (pos.lat !== spec.position.lat || pos.lng !== spec.position.lng) {
          current.setLatLng(spec.position);
        }
        if (previousCount !== count) {
          current.setIcon(this.#clusterIcon(count, spec.ids));
          const title = this.options.clusterTitle(count, spec.ids);
          const aria = this.options.clusterAriaLabel(count, spec.ids);
          current.options.title = title;
          current.options.ariaLabel = aria;
          if (current.el) {
            current.el.title = title;
            current.el.setAttribute("aria-label", aria);
          }
        }
        continue;
      }
      this.clusters.set(key, this.#acquireClusterMarker(key, spec));
    }

    this._clusterSyncZoom = layout.zoomBucket;
    this._clusterSyncGeneration = this._layoutGeneration;
  }

  #acquireClusterMarker(key: string, spec: ClusterSpec): Marker {
    const count = spec.count || spec.ids.length;
    const title = this.options.clusterTitle(count, spec.ids);
    const aria = this.options.clusterAriaLabel(count, spec.ids);
    const icon = this.#clusterIcon(count, spec.ids);
    const pooled = this._clusterPool.pop();
    if (pooled) {
      this._clusterMarkerKey.set(pooled, key);
      pooled.setLatLng(spec.position);
      pooled.setIcon(icon);
      pooled.options.title = title;
      pooled.options.ariaLabel = aria;
      pooled.options.className = this.options.clusterClassName;
      if (pooled.el) {
        pooled.el.title = title;
        pooled.el.setAttribute("aria-label", aria);
        pooled.el.className = `oh-marker ${this.options.clusterClassName}`.trim();
      }
      pooled.addTo(this.map as Orihon);
      return pooled;
    }

    const created = new Marker(spec.position, {
      title,
      ariaLabel: aria,
      className: this.options.clusterClassName,
      icon
    });
    this._clusterMarkerKey.set(created, key);
    created.on("click", (event) => {
      const clusterId = this._clusterMarkerKey.get(created);
      if (clusterId != null) this.#clusterClick(clusterId, created, event);
    });
    created.addTo(this.map as Orihon);
    return created;
  }

  #releaseClusterMarker(marker: Marker): void {
    this._clusterMarkerKey.delete(marker);
    marker.remove();
    if (this._clusterPool.length < 512) {
      this._clusterPool.push(marker);
      return;
    }
    marker.off();
  }

  #drainClusterPool(): void {
    for (const marker of this._clusterPool) {
      marker.off();
      marker.remove();
    }
    this._clusterPool.length = 0;
  }

  #syncCanvasClusters(specs: Map<string, ClusterSpec>): void {
    if (!this.map) return;
    // Mirror DOM `#syncClusters` prune: canvas previously only set() and leaked
    // zoom-scoped keys + greedy leaf arrays across zoomend.
    for (const key of this.clusterMembers.keys()) {
      if (!specs.has(key)) this.clusterMembers.delete(key);
    }
    const items: { key: string; lat: number; lng: number; count: number }[] = [];
    for (const [key, spec] of specs) {
      const count = spec.count || spec.ids.length;
      if (spec.ids.length) this.clusterMembers.set(key, spec.ids);
      else this.clusterMembers.delete(key);
      items.push({
        key,
        lat: spec.position.lat,
        lng: spec.position.lng,
        count
      });
    }
    this._canvasClusterCount = items.length;
    if (!this._clusterCanvas) {
      this._clusterCanvas = clusterCanvasLayer({ pane: "marker", hitTolerance: 8 });
      this._clusterCanvas.on("clusterclick", (event) => this.#clusterCanvasClick(event));
      this._clusterCanvas.addTo(this.map as Orihon);
    }
    this._clusterCanvas.setClusters(items);
  }

  #clusterCanvasClick(event: Record<string, unknown>): void {
    (event.originalEvent as Event | undefined)?.stopPropagation();
    const key = String(event.clusterKey ?? "");
    if (!key) return;
    const latlng = (event.latlng as LatLngLike) || this._layout?.clusters.get(key)?.position;
    if (!latlng) return;
    this.#clusterClickAt(key, latlng, event);
  }

  #syncWebgl(layout: LayoutCache): void {
    if (!this.map) return;
    const zoomUnchanged = this._webglLayer && this._webglSyncedZoom === layout.zoomBucket && !this._layoutDirty;
    if (zoomUnchanged) {
      return;
    }

    const points: LatLngLike[] = [];
    const meta: WebGLMeta[] = [];
    const idToIndex = new Map<ObjectId, number>();
    // Clusters use canvas/DOM badges; only unclustered objects go to the GPU layer.
    for (const [id, record] of layout.singles) {
      idToIndex.set(id, points.length);
      points.push(record.position);
      meta.push({ kind: "object", id });
    }

    this._webglMeta = meta;
    this._webglIdToIndex = idToIndex;
    const colors = this.#buildWebglColors(meta);
    const interactive = points.length <= 40_000;
    if (!this._webglLayer) {
      this._webglLayer = webglPointLayer([], {
        pointSize: 10,
        color: "#0f766e",
        opacity: 0.88,
        maxDpr: 1.5,
        interactive,
        hitTolerance: 10
      });
      this._webglLayer.on("click", (event) => this.#webglClick(event));
      this._webglLayer.on("hover", (event) => this.#webglHover(event));
      this._webglLayer.addTo(this.map as Orihon);
    } else {
      this._webglLayer.setInteractive(interactive);
    }
    this._webglLayer.setData(points, { colors });
    this._webglSyncedZoom = layout.zoomBucket;
    if (!this.options.clusterize && !this.filter) {
      this.#snapshotWebglPack(
        layout.singles,
        meta,
        idToIndex,
        colors
      );
    }
  }

  #buildFlatLayout(zoomBucket: number): void {
    const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
    for (const record of this.index.records.values()) {
      if (this.filter && !this.filter(record.value, record.id)) continue;
      singles.set(record.id, record);
    }
    this._layout = { zoomBucket, singles, clusters: new Map() };
    this._layoutDirty = false;
    this._clusterIndex = null;
    this._webglSyncedZoom = null;
  }

  #canPatchWebgl(): boolean {
    return Boolean(
      this._webglLayer &&
        !this.options.clusterize &&
        this.#shouldUseWebgl() &&
        this._webglIdToIndex.size > 0
    );
  }

  /** Filter / resync without greedy cluster layout (WebGL, no clusters). */
  #fastWebglFilterSync(): void {
    if (!this.map) return;
    const zoomBucket = Math.floor(this.map.zoom);

    // Restore or compact from the full pack — avoids re-running latLng→mercator for 1M points.
    if (this._webglPack && this._webglLayer) {
      if (!this.filter) {
        this.#applyWebglPack(this._webglPack, zoomBucket, true);
        return;
      }
      const pack = this._webglPack;
      let w = 0;
      const meta: WebGLMeta[] = [];
      const idToIndex = new Map<ObjectId, number>();
      const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
      const latlng = new Float32Array(pack.latlng.length);
      const merc64 = new Float64Array(pack.merc64.length);
      const colors = pack.colors ? new Float32Array(pack.colors.length) : null;
      for (let i = 0; i < pack.meta.length; i++) {
        const entry = pack.meta[i];
        const object = this.items.get(entry.id);
        if (!object || (this.filter && !this.filter(object, entry.id))) continue;
        const record = pack.singles.get(entry.id) || this.index.records.get(entry.id);
        if (!record) continue;
        latlng[w * 2] = pack.latlng[i * 2];
        latlng[w * 2 + 1] = pack.latlng[i * 2 + 1];
        merc64[w * 2] = pack.merc64[i * 2];
        merc64[w * 2 + 1] = pack.merc64[i * 2 + 1];
        if (colors && pack.colors) {
          const s = i * 4;
          const d = w * 4;
          colors[d] = pack.colors[s];
          colors[d + 1] = pack.colors[s + 1];
          colors[d + 2] = pack.colors[s + 2];
          colors[d + 3] = pack.colors[s + 3];
        }
        idToIndex.set(entry.id, w);
        meta.push(entry);
        singles.set(entry.id, record);
        w += 1;
      }
      // Recompute colors when selection/hover active — pack stores base category colors.
      const liveColors =
        this.options.styleByCategory && (this._selectedId != null || this._hoveredId != null)
          ? this.#buildWebglColors(meta)
          : colors
            ? colors.subarray(0, w * 4)
            : this.#buildWebglColors(meta);
      this._webglLayer.setPackedData(latlng.subarray(0, w * 2), merc64.subarray(0, w * 2), {
        colors: liveColors
      });
      this._layout = { zoomBucket, singles, clusters: new Map() };
      this._layoutDirty = false;
      this._webglMeta = meta;
      this._webglIdToIndex = idToIndex;
      this._visibleObjects = w;
      this._webglSyncedZoom = zoomBucket;
      this._activeRenderer = "webgl";
      this._webglLayer.setInteractive(w <= 40_000);
      this.emit("render", { stats: this.getStats() });
      return;
    }

    const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
    const points: LatLngLike[] = [];
    const meta: WebGLMeta[] = [];
    const idToIndex = new Map<ObjectId, number>();

    for (const record of this.index.records.values()) {
      if (this.filter && !this.filter(record.value, record.id)) continue;
      singles.set(record.id, record);
      idToIndex.set(record.id, points.length);
      points.push(record.position);
      meta.push({ kind: "object", id: record.id });
    }

    this._layout = { zoomBucket, singles, clusters: new Map() };
    this._layoutDirty = false;
    this._clusterIndex = null;
    this._webglMeta = meta;
    this._webglIdToIndex = idToIndex;
    this._visibleObjects = meta.length;
    this._activeRenderer = "webgl";
    this.#clearObjectMarkers();
    this.#clearClusterCanvas();
    this.#clearDomClusters();

    const colors = this.#buildWebglColors(meta);
    const interactive = points.length <= 40_000;
    if (!this._webglLayer) {
      this._webglLayer = webglPointLayer([], {
        pointSize: 10,
        color: "#0f766e",
        opacity: 0.88,
        maxDpr: 1.5,
        interactive,
        hitTolerance: 10
      });
      this._webglLayer.on("click", (event) => this.#webglClick(event));
      this._webglLayer.on("hover", (event) => this.#webglHover(event));
      this._webglLayer.addTo(this.map as Orihon);
    } else {
      this._webglLayer.setInteractive(interactive);
    }
    this._webglLayer.setData(points, { colors });
    this._webglSyncedZoom = zoomBucket;

    // Snapshot the unfiltered pack once so later filters are O(visible) copies.
    if (!this.filter) {
      this.#snapshotWebglPack(singles, meta, idToIndex, colors);
    }

    this.emit("render", { stats: this.getStats() });
  }

  #applyWebglPack(
    pack: NonNullable<ObjectManager["_webglPack"]>,
    zoomBucket: number,
    rebuildColors: boolean
  ): void {
    if (!this._webglLayer) return;
    const colors =
      rebuildColors && this.options.styleByCategory
        ? this.#buildWebglColors(pack.meta)
        : pack.colors;
    this._webglLayer.setPackedData(pack.latlng, pack.merc64, { colors });
    this._layout = { zoomBucket, singles: pack.singles, clusters: new Map() };
    this._layoutDirty = false;
    this._webglMeta = pack.meta;
    this._webglIdToIndex = pack.idToIndex;
    this._visibleObjects = pack.meta.length;
    this._webglSyncedZoom = zoomBucket;
    this._activeRenderer = "webgl";
    this._webglLayer.setInteractive(pack.meta.length <= 40_000);
    this.emit("render", { stats: this.getStats() });
  }

  #snapshotWebglPack(
    singles: Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>,
    meta: WebGLMeta[],
    idToIndex: Map<ObjectId, number>,
    colors: Float32Array | null
  ): void {
    if (!this._webglLayer) return;
    const latlng = this._webglLayer.getLatLngBuf().slice();
    const merc64 = this._webglLayer.getMercator64().slice();
    this._webglPack = {
      latlng,
      merc64,
      colors: colors ? colors.slice() : null,
      meta: meta.slice(),
      idToIndex: new Map(idToIndex),
      singles
    };
  }

  #buildWebglColors(meta: WebGLMeta[]): Float32Array | null {
    if (!this.options.styleByCategory) return null;
    const colors = new Float32Array(meta.length * 4);
    for (let i = 0; i < meta.length; i++) {
      const entry = meta[i];
      const object = entry.kind === "object" ? this.items.get(entry.id) : undefined;
      const rgba = this.#rgbaForObject(object, entry.kind === "object" ? entry.id : null);
      const o = i * 4;
      colors[o] = rgba[0];
      colors[o + 1] = rgba[1];
      colors[o + 2] = rgba[2];
      colors[o + 3] = rgba[3];
    }
    return colors;
  }

  #rgbaForObject(object: ManagedObject | undefined, id: ObjectId | null): readonly [number, number, number, number] {
    if (id != null && this._selectedId != null && id === this._selectedId) return OBJECT_MANAGER_PALETTE.selected;
    if (id != null && this._hoveredId != null && id === this._hoveredId) return OBJECT_MANAGER_PALETTE.hover;
    if (object?.properties?.alert) return OBJECT_MANAGER_PALETTE.alert;
    const category = String(object?.properties?.category || "alpha");
    if (category === "beta") return OBJECT_MANAGER_PALETTE.beta;
    if (category === "gamma") return OBJECT_MANAGER_PALETTE.gamma;
    return OBJECT_MANAGER_PALETTE.alpha;
  }

  #refreshWebglColors(): void {
    if (!this._webglLayer || !this._webglMeta.length || !this.options.styleByCategory) return;
    this._webglLayer.setColors(this.#buildWebglColors(this._webglMeta));
  }

  #patchWebglColors(ids: ObjectId[]): void {
    if (!this._webglLayer || !this.options.styleByCategory) return;
    for (const id of ids) {
      const slot = this._webglIdToIndex.get(id);
      if (slot == null) continue;
      const object = this.items.get(id);
      this._webglLayer.patchColor(slot, this.#rgbaForObject(object, id));
    }
  }

  #webglClick(event: Record<string, unknown>): void {
    const index = Number(event.index);
    const entry = this._webglMeta[index];
    if (!entry || entry.kind !== "object") return;
    const object = this.items.get(entry.id);
    this.setSelected(entry.id);
    const payload = {
      ...event,
      objectId: entry.id,
      object
    };
    this.emit("click", payload);
    if (object && this._popupBinding) {
      this.#openObjectPopup(entry.id, object, (event.latlng as LatLngLike) || this.#objectPosition(object)!, payload);
    }
  }

  #webglHover(event: Record<string, unknown>): void {
    const index = Number(event.index);
    if (!Number.isFinite(index) || index < 0) {
      if (this._hoveredId != null) {
        this.setHovered(null);
        this.emit("hover", { objectId: null, object: null, ...event });
      }
      return;
    }
    const entry = this._webglMeta[index];
    if (!entry || entry.kind !== "object") {
      this.setHovered(null);
      this.emit("hover", { objectId: null, object: null, ...event });
      return;
    }
    if (this._hoveredId === entry.id) return;
    this.setHovered(entry.id);
    this.emit("hover", {
      ...event,
      objectId: entry.id,
      object: this.items.get(entry.id)
    });
  }

  #clusterMemberIds(key: string): ObjectId[] {
    const cached = this.clusterMembers.get(key);
    if (cached) return cached;
    const spec = this._layout?.clusters.get(key);
    if (!spec) return [];
    if (spec.ids.length) {
      this.clusterMembers.set(key, spec.ids);
      return spec.ids;
    }
    if (spec.nodeId >= 0 && this._clusterIndex) {
      const ids = collectClusterLeaves(this._clusterIndex, spec.nodeId) as ObjectId[];
      spec.ids = ids;
      this.clusterMembers.set(key, ids);
      return ids;
    }
    return [];
  }

  #clusterClick(key: string, marker: Marker, event: Record<string, unknown>): void {
    this.#clusterClickAt(key, marker.getLatLng(), { ...event, layer: marker });
  }

  #clusterClickAt(key: string, position: LatLngLike, event: Record<string, unknown>): void {
    const ids = [...this.#clusterMemberIds(key)];
    const payload = {
      ...event,
      clusterId: key,
      objectIds: ids,
      count: ids.length,
      latlng: position
    };
    this.emit("clusterclick", payload);
    if (this._clusterPopupBinding) this.#openClusterPopup(key, ids, position, payload);
    if (!this.map) return;
    if (this.map.zoom >= this.options.clusterMaxZoom) {
      this.spiderfyCluster(key);
      return;
    }
    if (!this.options.clusterZoomOnClick) return;
    this.unspiderfy();
    if (this.options.zoomToBoundsOnClick) {
      const bounds = latLngBounds();
      for (const id of ids) {
        const object = this.items.get(id);
        const objectPosition = object ? this.#objectPosition(object) : null;
        if (objectPosition) bounds.extend(objectPosition);
      }
      if (bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: 40 });
        return;
      }
    }
    this.map.setView(position, Math.min(this.options.clusterMaxZoom, this.map.zoom + 2));
  }

  #objectClickAt(id: ObjectId, marker: Marker, event: Record<string, unknown>): void {
    const object = this.items.get(id);
    this.setSelected(id);
    const payload = { ...event, objectId: id, object, layer: marker };
    this.emit("click", payload);
    if (object && this._popupBinding) this.#openObjectPopup(id, object, marker.getLatLng(), payload);
  }

  #openObjectPopup(
    id: ObjectId,
    object: ManagedObject,
    position: LatLngLike,
    event?: Record<string, unknown>
  ): void {
    const binding = this._popupBinding;
    if (!binding || !this.map) return;
    const content: OverlayContent = typeof binding.content === "function"
      ? (context) => (binding.content as (object: ManagedObject, id: ObjectId, context: ObjectPopupContext) => OverlayRenderable | Promise<OverlayRenderable>)(object, id, {
          ...context,
          manager: this,
          object,
          objectId: id
        })
      : binding.content;
    this.#showPopup(content, binding.options, position, { object, objectId: id }, event);
  }

  #openClusterPopup(
    clusterId: string,
    ids: ObjectId[],
    position: LatLngLike,
    event?: Record<string, unknown>
  ): void {
    const binding = this._clusterPopupBinding;
    if (!binding || !this.map) return;
    const objects = ids.map((id) => this.items.get(id)).filter((value): value is ManagedObject => Boolean(value));
    const content: OverlayContent = typeof binding.content === "function"
      ? (context) => (binding.content as (objects: ManagedObject[], ids: ObjectId[], context: ClusterPopupContext) => OverlayRenderable | Promise<OverlayRenderable>)(objects, ids, {
          ...context,
          manager: this,
          clusterId,
          objectIds: [...ids],
          objects
        })
      : binding.content;
    this.#showPopup(content, binding.options, position, { clusterId, objectIds: [...ids], objects }, event);
  }

  #showPopup(
    content: OverlayContent,
    options: PopupOptions | undefined,
    position: LatLngLike,
    data: unknown,
    event?: Record<string, unknown>
  ): void {
    if (!this.map) return;
    this.closePopup();
    const next = new Popup(content, options);
    next.setContentContext({ source: this, event: event as OrihonEvent | undefined, data });
    next.setLatLng(position);
    next.on("close", () => {
      if (this._activePopup === next) this._activePopup = null;
    });
    this._activePopup = next;
    next.openOn(this.map as Orihon);
  }

  #clusterIcon(count: number, ids: ObjectId[] = []): MarkerIcon {
    const custom = this.options.clusterIcon?.(count, ids);
    if (custom) return custom;
    const tier = count < 10 ? "sm" : count < 100 ? "md" : "lg";
    const size = tier === "sm" ? 36 : tier === "md" ? 44 : 52;
    return new DivIcon({
      content: String(count),
      className: `oh-cluster-icon oh-cluster-icon--${tier}`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }

  #dropRenderedObject(id: ObjectId): void {
    const marker = this.markers.get(id);
    marker?.remove();
    this.markers.delete(id);
  }

  #clearObjectMarkers(): void {
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
  }

  #clearDomClusters(): void {
    for (const marker of this.clusters.values()) this.#releaseClusterMarker(marker);
    this.clusters.clear();
    this._clusterSyncZoom = null;
    this._clusterSyncGeneration = -1;
  }

  #clearDomMarkers(): void {
    this.#clearObjectMarkers();
    this.#clearDomClusters();
  }

  #clearWebgl(): void {
    if (this._webglLayer) {
      this._webglLayer.off();
      this._webglLayer.remove();
      this._webglLayer = null;
    }
    this._webglMeta = [];
    this._webglIdToIndex.clear();
    this._webglPack = null;
    this._webglSyncedZoom = null;
  }

  #clearClusterCanvas(): void {
    if (this._clusterCanvas) {
      this._clusterCanvas.off();
      this._clusterCanvas.remove();
      this._clusterCanvas = null;
    }
    this._canvasClusterCount = 0;
  }

  #clearRendered(): void {
    this.unspiderfy();
    this.#clearDomMarkers();
    this.#clearWebgl();
    this.#clearClusterCanvas();
    this.clusterMembers.clear();
    this._activeRenderer = "dom";
  }

  #objectPosition(item: ManagedObject): LatLngLike | null {
    const coordinates = item.geometry?.coordinates
      ? [item.geometry.coordinates[1], item.geometry.coordinates[0]]
      : item.coordinates;
    if (!coordinates) return null;
    const source = Array.isArray(coordinates)
      ? coordinates
      : [coordinates.lat, coordinates.lng];
    if (!Number.isFinite(Number(source[0])) || !Number.isFinite(Number(source[1]))) return null;
    return [Number(source[0]), Number(source[1])];
  }
}

export function objectManager(options?: ObjectManagerOptions): ObjectManager {
  return new ObjectManager(options);
}
