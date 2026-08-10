import { Evented, type OrihonEvent, type EventHandler } from "../events.js";
import { rafThrottle } from "../dom.js";
import { ClusterCanvasLayer, clusterCanvasLayer } from "../layers/cluster-canvas-layer.js";
import { DivIcon, type MarkerIcon } from "../layers/icon.js";
import { Marker, type MarkerOptions } from "../layers/marker.js";
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

export interface ObjectManagerOptions {
  minZoom?: number;
  marker?: MarkerOptions;
  clusterize?: boolean;
  /**
   * Cluster radius in CSS/world pixels at the clustered zoom (Leaflet-style).
   * Kept name `clusterGridSize` for compatibility; was formerly a grid cell size.
   * Default 50. Clamped to ≥ 20.
   */
  clusterGridSize?: number;
  clusterMinPoints?: number;
  clusterMaxZoom?: number;
  clusterZoomOnClick?: boolean;
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
  private _webglSyncedZoom: number | null = null;
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
      indexCellSize: 1,
      clusterIcon: null,
      clusterClassName: "oh-cluster-marker",
      clusterTitle: (count) => `${count} objects`,
      clusterAriaLabel: (count) => `${count} map objects`,
      clusterRenderer: "auto",
      webglThreshold: 2000,
      layoutWorker: "auto",
      layoutWorkerThreshold: 5000,
      ...options
    };
    this.options.clusterGridSize = Math.max(20, Number(this.options.clusterGridSize));
    this.options.clusterMinPoints = Math.max(2, Math.floor(this.options.clusterMinPoints));
    this.options.webglThreshold = Math.max(1, Math.floor(this.options.webglThreshold));
    this.options.layoutWorkerThreshold = Math.max(1, Math.floor(this.options.layoutWorkerThreshold));
    this.index = new SpatialGridIndex<ManagedObject, ObjectId>(this.options.indexCellSize);
    this._render = () => this.render();
    this._scheduleRender = rafThrottle(() => this.render());
    this._workerPool = geometryWorkerPool();
  }

  addTo(map: ObjectManagerMap): this {
    if (this.map === map) return this;
    this.remove();
    this.map = map;
    map.on("moveend", this._scheduleRender);
    map.on("zoomend", this._scheduleRender);
    map.on("resize", this._scheduleRender);
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
    for (const item of list) {
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

  removeObjects(ids: ObjectId | ObjectId[]): this {
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
    this.filter = filter;
    this.#invalidateLayout();
    this._scheduleRender();
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

  setClusterize(enabled: boolean): this {
    if (this.options.clusterize === Boolean(enabled)) return this;
    this.options.clusterize = Boolean(enabled);
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
    this.#invalidateLayout();
    this.#clearRendered();
    this._scheduleRender();
    return this;
  }

  setClusterRenderer(renderer: ClusterRenderer): this {
    if (this.options.clusterRenderer === renderer) return this;
    this.options.clusterRenderer = renderer;
    this.#clearRendered();
    this._scheduleRender();
    return this;
  }

  clear(): this {
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
        this._visibleObjects = this.#countVisibleFromLayout(layout, bounds, new Map());
        this.#clearClusterCanvas();
        this.#clearDomClusters();
        this.#syncWebgl(layout);
      }
      this.emit("render", { stats: this.getStats() });
      return;
    }

    const visibleIds = new Set(
      this.index.search(bounds, (record) => !this.filter || this.filter(record.value, record.id)).map((record) => record.id)
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
    const mode = this.options.layoutWorker;
    if (mode === true) return true;
    if (mode === false) return false;
    return this.index.size >= this.options.layoutWorkerThreshold;
  }

  #collectLayoutRequest(zoomBucket: number) {
    const ids: ObjectId[] = [];
    const values: number[] = [];
    for (const record of this.index.records.values()) {
      if (this.filter && !this.filter(record.value, record.id)) continue;
      ids.push(record.id);
      values.push(record.position.lat, record.position.lng);
    }
    return {
      ids,
      coords: new Float64Array(values),
      zoomBucket,
      gridSize: this.options.clusterGridSize,
      minPoints: this.options.clusterMinPoints,
      clusterize: this.options.clusterize,
      clusterMaxZoom: this.options.clusterMaxZoom
    };
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
    this._clusterSyncZoom = null;
    this._clusterSyncGeneration = -1;
    this._layoutGeneration++;
    this._layoutPromise = null;
    this._greedyCache.clear();
    this._pendingGreedyZoom = null;
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
        continue;
      }
      const title = record.value.properties?.title || "";
      const created = new Marker(record.position, { ...this.options.marker, title });
      created.on("click", (event) => {
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
      created.addTo(this.map as Orihon);
      this.markers.set(id, created);
    }
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
    const key = String(event.clusterKey ?? "");
    if (!key) return;
    const latlng = (event.latlng as LatLngLike) || this._layout?.clusters.get(key)?.position;
    if (!latlng) return;
    this.#clusterClickAt(key, latlng, event);
  }

  #syncWebgl(layout: LayoutCache): void {
    if (!this.map) return;
    if (this._webglLayer && this._webglSyncedZoom === layout.zoomBucket && !this._layoutDirty) {
      return;
    }

    const points: LatLngLike[] = [];
    const meta: WebGLMeta[] = [];
    // Clusters use canvas/DOM badges; only unclustered objects go to the GPU layer.
    for (const [id, record] of layout.singles) {
      points.push(record.position);
      meta.push({ kind: "object", id });
    }

    this._webglMeta = meta;
    if (!this._webglLayer) {
      this._webglLayer = webglPointLayer(points, {
        pointSize: 10,
        color: "#0f766e",
        opacity: 0.88,
        maxDpr: 1.5,
        interactive: true,
        hitTolerance: 10
      });
      this._webglLayer.on("click", (event) => this.#webglClick(event));
      this._webglLayer.addTo(this.map as Orihon);
    } else {
      this._webglLayer.setData(points);
    }
    this._webglSyncedZoom = layout.zoomBucket;
  }

  #webglClick(event: Record<string, unknown>): void {
    const index = Number(event.index);
    const entry = this._webglMeta[index];
    if (!entry || entry.kind !== "object") return;
    const object = this.items.get(entry.id);
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
    if (!this.map || !this.options.clusterZoomOnClick) return;
    this.map.setView(position, Math.min(this.options.clusterMaxZoom + 1, this.map.zoom + 2));
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
