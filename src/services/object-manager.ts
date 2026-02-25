import { Evented, type OrihonEvent, type EventHandler } from "../events.js";
import type { FeatureSourceChange, ReadonlyFeatureSource } from "../source-types.js";
import { CRSCompatibilityError } from "../crs.js";
import { rafThrottle } from "../dom.js";
import { ClusterCanvasLayer, clusterCanvasLayer } from "../layers/cluster-canvas-layer.js";
import { DivIcon, type MarkerIcon } from "../layers/icon.js";
import { Marker, type MarkerOptions } from "../layers/marker.js";
import type { GeoJSONFeature } from "../layers/geojson.js";
import { Polyline, polyline } from "../layers/vector.js";
import { WebGLPointLayer, webglPointLayer } from "../layers/webgl-point-layer.js";
import { LatLng, LatLngBounds, Point, clampLat, latLng, bounds, wrapLng, type LatLngBoundsLike, type LatLngLike, type PointLike } from "../geo.js";
import type { Orihon } from "../map.js";
import { nonNegativeFinite, rejectLegacyUnit } from "../units.js";
import { AbortableOperation, abortError } from "./abortable-operation.js";
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
import { GeometryWorkerPool, getSharedGeometryWorkerPool } from "./geometry-worker.js";
import { SpatialGridIndex, type SpatialRecord } from "./spatial-grid-index.js";
import type { QueryHit, ResolvedQueryOptions } from "../layer.js";
import { parseCssColor } from "../webgl-utils.js";
import {
  DEFAULT_MAX_VERTICES_PER_GEOMETRY,
  tryNormalizeManagedGeometry,
  assertManagedCoordinateFormat,
  readManagedPoint,
  type ManagedGeometry,
  type ManagedLineStringGeometry,
  type ManagedPointGeometry,
  type ManagedPolygonGeometry,
  type NormalizedGeometry
} from "./object-geometry.js";
import type { LabelCandidate } from "./object-label-layout.js";
import { ObjectSceneController } from "./object-scene.js";
import { normalizeLabel, styleTint } from "./object-style-helpers.js";
import type { ObjectVisualizationByZoom, ObjectVisualizationMode } from "./object-scene.js";
import type { HeatBackend, HeatMode, HeatEvaluation } from "./heat.js";
import type { ManagedIconOptions, ManagedIconSource } from "./object-icon-atlas.js";
import type { ObjectSearchOptions, ObjectSearchResult } from "./object-search-index.js";
import type { ClusterPropertiesConfig } from "./object-cluster-aggregates.js";
import {
  isAsyncIterable,
  resolveAsyncBatchOptions,
  throwIfAsyncAborted,
  yieldAsyncBatch,
  type AsyncBatchOptions
} from "./async-batch.js";
import {
  ObjectDirtyFlags,
  type ObjectCollisionMode,
  type ObjectGradientStop,
  type ObjectId,
  type ObjectLabelStyle,
  type ObjectLineStyle,
  type ObjectPolygonStyle,
  type ObjectState,
  type ObjectStateValue,
  type ObjectStyle,
  type ObjectStyleContext,
  type ObjectStyleResolver,
  type ObjectTrailStyle
} from "./object-types.js";

export type { ObjectId } from "./object-types.js";
export type {
  ManagedGeometry,
  ManagedLineStringGeometry,
  ManagedPointGeometry,
  ManagedPolygonGeometry
} from "./object-geometry.js";
export type {
  ObjectCollisionMode,
  ObjectGradientStop,
  ObjectLabelStyle,
  ObjectLineStyle,
  ObjectPolygonStyle,
  ObjectState,
  ObjectStateValue,
  ObjectStyle,
  ObjectStyleContext,
  ObjectStyleResolver,
  ObjectTrailStyle
} from "./object-types.js";
export type { ObjectSearchOptions, ObjectSearchResult } from "./object-search-index.js";
export type { ClusterPropertiesConfig, ClusterPropertyDefinition } from "./object-cluster-aggregates.js";
export type { ObjectVisualizationByZoom, ObjectVisualizationMode } from "./object-scene.js";
export type { ManagedIconOptions, ManagedIconSource } from "./object-icon-atlas.js";

let objectId = 0;

function deferClusterHierarchy(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => setTimeout(fn, 0));
    return;
  }
  setTimeout(fn, 0);
}

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export interface ManagedObject {
  id?: ObjectId;
  /** Named point position. GeoJSON tuples belong in `geometry.coordinates`. */
  coordinates?: LatLngLike;
  geometry?: ManagedGeometry | { coordinates?: number[]; type?: string };
  properties?: { title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ObjectManagerAsyncOptions extends AsyncBatchOptions {
  /** Schedule one render/layout invalidation after the import. Default true. */
  render?: boolean;
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

interface ResolvedObjectStyle {
  color: string;
  rgba: readonly [number, number, number, number];
  opacity: number;
  size: number;
  icon: string | null;
  iconTint: string | null;
  rotation: number;
  visible: boolean;
  label: ObjectLabelStyle | null;
  collisionMode: ObjectCollisionMode;
  trail: ObjectTrailStyle | null;
  line: ObjectLineStyle | null;
  polygon: ObjectPolygonStyle | null;
}

const EMPTY_OBJECT_STATE: Readonly<ObjectState> = Object.freeze({});
const DEFAULT_OBJECT_COLOR = "#0f766e";
const DEFAULT_OBJECT_RGB = { r: 15, g: 118, b: 110 } as const;
const DEFAULT_OBJECT_SIZE = 10;
const DEFAULT_OBJECT_OPACITY = 0.88;
const MAX_OBJECT_SIZE = 256;

const PALETTE_HEX = {
  alpha: "#0f766e",
  beta: "#2563eb",
  gamma: "#ca8a04",
  alert: "#dc2626",
  selected: "#7c3aed",
  hover: "#f59e0b"
} as const;

export interface ObjectManagerOptions {
  /** Optional reactive GeoJSON source shared with GeoJSON and text layers. */
  source?: ReadonlyFeatureSource<GeoJSONFeature> | null;
  minZoom?: number;
  marker?: MarkerOptions;
  clusterize?: boolean;
  /** When true (default), WebGL singles use category/alert/selected/hover palette colors. */
  styleByCategory?: boolean;
  /**
   * Data-driven style resolver. Point styles use fill/fillOpacity/size; color/opacity
   * remain compatibility aliases. Unspecified properties fall back to legacy/defaults.
   * Priority: base defaults → legacy category/alert/selected/hover → custom `style` → normalize.
   */
  style?: ObjectStyleResolver | null;
  /**
   * Cluster radius in CSS/world pixels at the clustered zoom (Leaflet-style).
   * Default 50. Clamped to ≥ 20.
   */
  clusterRadiusPixels?: number;
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
   * Offload first/zoom cluster layout to a Worker.
   * - `true` / `false` — force
   * - `auto` — worker when indexed objects ≥ `layoutWorkerThreshold`
   */
  layoutWorker?: boolean | "auto";
  /** Default 5000. */
  layoutWorkerThreshold?: number;
  /**
   * Largest collection that gets a full all-zoom cluster hierarchy. Above this
   * limit ObjectManager keeps compact, worker-built layouts only for zooms that
   * are actually visited. Default 250000. `0` = unlimited hierarchy.
   */
  clusterHierarchyMaxObjects?: number;
  /** Stop `add()` once this many objects are stored. `0` / unset = unlimited. */
  maxObjects?: number;
  /** Enable label/icon declutter in the viewport. */
  declutter?: boolean;
  /** Active visualization strategy. Default "objects". */
  visualization?: ObjectVisualizationMode;
  visualizationByZoom?: ObjectVisualizationByZoom;
  /** Local search index fields (e.g. `properties.name`). */
  search?: { fields: string[]; normalize?: boolean } | null;
  /** Temporal filter extractors (Unix ms). */
  time?: {
    value?: (object: ManagedObject) => number | null;
    from?: (object: ManagedObject) => number | null;
    to?: (object: ManagedObject) => number | null;
  } | null;
  /** Cluster aggregate reducers. */
  clusterProperties?: ClusterPropertiesConfig;
  /** Optional heatmap value/weight for visualization:"heatmap"|"auto". */
  heatmapWeight?: ((object: ManagedObject, id?: ObjectId) => number) | null;
  /** Heat visualization from one scalar field: colors, contours, or both. Default "heatmap". */
  heatmapDisplay?: HeatMode;
  /** Draw one caption per visible contour level. Default true. */
  heatmapIsolineLabels?: boolean;
  /** Scalar-field compute backend. `auto` avoids GPU readback for contour modes. */
  heatmapBackend?: HeatBackend;
  /** Full immutable dataset field, or per-zoom refinement. Default `"static"`. */
  heatmapEvaluation?: HeatEvaluation;
  /** Absolute isoline value interval, or automatic engineering step. */
  heatmapIsolineStep?: "auto" | number;
  /** Cluster badge styling using aggregate properties. */
  clusterStyle?: ((
    cluster: { id: string; count: number; properties: Record<string, number>; containsSelected: boolean },
    context: Readonly<ObjectStyleContext>
  ) => ObjectStyle | null | undefined) | null;
  /**
   * Icon/label/trail/path/polygon scene layers + per-object scene geometries.
   * Set `false` for mass WebGL points (100k–1M) — skips the O(n) scene sync that
   * otherwise runs on every render after Phase-2 scene work.
   * Default `true`.
   */
  sceneFeatures?: boolean;
  /**
   * Cap LineString/Polygon vertex count on ingest. Default 65536. `0` = unlimited.
   */
  maxVerticesPerGeometry?: number;
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
  clusterStrategy: "none" | "greedy" | "hierarchy";
}

interface ObjectManagerMap extends Evented {
  zoom: number;
  size?: { width: number; height: number };
  getBounds(): LatLngBoundsLike;
  getPane?(name: string): HTMLElement | null | undefined;
  latLngToLayerPoint(value: LatLngLike): Point;
  latLngToContainerPoint?(value: LatLngLike): Point;
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

interface WebGLIdIndex {
  readonly size: number;
  get(id: ObjectId): number | undefined;
  has(id: ObjectId): boolean;
  clear(): void;
}

/**
 * Zero-storage id → GPU-slot index for the common mass-data case where ids are
 * exactly 0..N-1. It preserves the Map-like lookup contract used internally
 * without allocating/hash-inserting a million entries.
 */
class DenseObjectIdIndex implements WebGLIdIndex {
  private _size: number;

  constructor(size: number) {
    this._size = size;
  }

  get(id: ObjectId): number | undefined {
    return typeof id === "number" && id >= 0 && id < this._size && Number.isInteger(id) ? id : undefined;
  }

  has(id: ObjectId): boolean {
    return this.get(id) !== undefined;
  }

  clear(): void {
    this._size = 0;
  }

  get size(): number {
    return this._size;
  }
}

function cloneWebglIdIndex(index: WebGLIdIndex): Map<ObjectId, number> {
  if (index instanceof Map) return new Map(index);
  const result = new Map<ObjectId, number>();
  for (let slot = 0; slot < index.size; slot++) result.set(slot, slot);
  return result;
}

interface WebGLSyncProfile {
  points: number;
  totalMs: number;
  packMs: number;
  packAllocateMs: number;
  packFillMs: number;
  styleMs: number;
  layerMs: number;
  canonicalMs: number;
  styled: boolean;
  zeroCopyCanonical: boolean;
  denseIdIndex: boolean;
}

type ResolvedObjectManagerOptions = Required<ObjectManagerOptions>;

export class ObjectManager extends Evented {
  #destroyed = false;
  readonly #imports = new Set<AbortableOperation>();
  readonly #mapUnload = (): void => { this.detach(); };
  get isDestroyed(): boolean { return this.#destroyed; }

  protected assertAlive(): void {
    if (this.#destroyed) throw abortError("ObjectManager was destroyed");
  }
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
  readonly _scheduleLabelRedraw: () => void;
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
  private _webglIdToIndex: WebGLIdIndex = new Map<ObjectId, number>();
  /** Full (unfiltered) GPU pack — filter/live compact without re-encoding mercator. */
  private _webglPack: {
    latlng: Float32Array;
    merc64: Float64Array;
    colors: Float32Array | null;
    sizes: Float32Array | null;
    meta: WebGLMeta[];
    idToIndex: WebGLIdIndex;
    singles: Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>;
  } | null = null;
  /** GPU draw list is a sparse subset of `_webglPack` (alarms-only etc). */
  private _gpuSubset = false;
  private _heatWeightBuf = new Float32Array(0);
  /** Reused source-slot scratch for compacting filtered WebGL packs. */
  private _webglFilterIndexScratch = new Uint32Array(0);
  /** Reused packed slot mask for indexed temporal filtering. */
  private _webglSystemMask = new Uint32Array(0);
  /** Last full WebGL rebuild timings; intentionally internal but readable from JS benchmarks. */
  private _webglSyncProfile: WebGLSyncProfile | null = null;
  /** Tiny bounded cache for repeated CSS colors returned by mass-point style resolvers. */
  private readonly _webglColorCache = new Map<string, readonly [number, number, number]>();
  /** Reused buffers for batched WebGL style patches. */
  private _webglStylePatchIndices = new Uint32Array(0);
  private _webglStylePatchColors = new Float32Array(0);
  private _webglStylePatchSizes = new Float32Array(0);
  private _heatRefreshTimer = 0;
  private _heatRefreshPending = false;
  private _webglSyncedZoom: number | null = null;
  private _webglDataEpoch = 0;
  private _webglSyncedEpoch = -1;
  /** Time-range + filter fingerprint so pan does not rebuild a compacted GPU view. */
  private _webglViewKey = "";
  private _selectedId: ObjectId | null = null;
  private _hoveredId: ObjectId | null = null;
  private readonly objectStates = new Map<ObjectId, ObjectState>();
  private _styleResolver: ObjectStyleResolver | null = null;
  private _styleZoom: number | null = null;
  /** Nested beginBulk()/endBulk() depth — suppress per-chunk invalidate+render. */
  private _bulkDepth = 0;
  private readonly scene = new ObjectSceneController();
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
  private _greedyPromise: Promise<void> | null = null;
  /** Above this size, never run sync greedy on every zoomend (stale+coalesce instead). */
  private _greedyZoomInlineLimit = 2500;
  private _layoutIds: ObjectId[] = [];
  private _layoutCoords = new Float64Array(0);
  private _layoutPacked = 0;
  private _layoutPackDirty = true;
  /** Monotonic version of the packed coordinate dataset installed in GeometryWorkerPool. */
  private _layoutDatasetVersion = 0;
  private _leafMask: Uint8Array | null = null;
  private _leafMaskFilter: ObjectFilter | null | undefined = undefined;
  private _leafMaskIndex: ClusterIndex | null = null;
  private _spiderMarkers: Marker[] = [];
  private _spiderLegs: Polyline[] = [];
  private _spiderClusterId: string | null = null;
  private _sourceUnsubscribe: (() => void) | null = null;
  private readonly _unspiderfyOnMapClick = (): void => { this.unspiderfy(); };

  constructor(options: ObjectManagerOptions = {}) {
    super();
    rejectLegacyUnit(options, "clusterGridSize", "clusterRadiusPixels");
    this.options = {
      minZoom: 0,
      marker: {},
      clusterize: false,
      clusterRadiusPixels: 50,
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
      clusterHierarchyMaxObjects: 250_000,
      styleByCategory: true,
      style: null,
      maxObjects: 0,
      declutter: false,
      visualization: "objects",
      visualizationByZoom: { heatmapUntil: 7, clustersUntil: 12 },
      search: null,
      time: null,
      clusterProperties: {},
      heatmapWeight: null,
      heatmapDisplay: "heatmap",
      heatmapIsolineLabels: true,
      heatmapBackend: "auto",
      heatmapEvaluation: "static",
      heatmapIsolineStep: "auto",
      clusterStyle: null,
      sceneFeatures: true,
      maxVerticesPerGeometry: DEFAULT_MAX_VERTICES_PER_GEOMETRY,
      source: null,
      ...options
    };
    this.options.clusterRadiusPixels = Math.max(20, nonNegativeFinite(this.options.clusterRadiusPixels, "clusterRadiusPixels"));
    this.options.clusterMinPoints = Math.max(2, Math.floor(this.options.clusterMinPoints));
    this.options.webglThreshold = Math.max(1, Math.floor(this.options.webglThreshold));
    this.options.layoutWorkerThreshold = Math.max(1, Math.floor(this.options.layoutWorkerThreshold));
    if (!["heatmap", "isolines", "both"].includes(this.options.heatmapDisplay)) {
      throw new TypeError(`Invalid heatmapDisplay: ${String(this.options.heatmapDisplay)}`);
    }
    if (!["auto", "wasm", "webgpu"].includes(this.options.heatmapBackend)) {
      throw new TypeError(`Invalid heatmapBackend: ${String(this.options.heatmapBackend)}`);
    }
    if (!["static", "zoom"].includes(this.options.heatmapEvaluation)) {
      throw new TypeError(`Invalid heatmapEvaluation: ${String(this.options.heatmapEvaluation)}`);
    }
    if (this.options.heatmapIsolineStep !== "auto" &&
        (!Number.isFinite(this.options.heatmapIsolineStep) || this.options.heatmapIsolineStep <= 0)) {
      throw new TypeError(`Invalid heatmapIsolineStep: ${String(this.options.heatmapIsolineStep)}`);
    }
    const hierarchyLimit = Number(this.options.clusterHierarchyMaxObjects);
    this.options.clusterHierarchyMaxObjects = Number.isFinite(hierarchyLimit)
      ? Math.max(0, Math.floor(hierarchyLimit))
      : 250_000;
    this.options.maxObjects = Math.max(0, Math.floor(Number(this.options.maxObjects) || 0));
    this.options.maxVerticesPerGeometry = Math.max(
      0,
      Math.floor(Number(this.options.maxVerticesPerGeometry) || 0)
    );
    this.options.spiderfyDistanceMultiplier = Math.max(0.25, Number(this.options.spiderfyDistanceMultiplier) || 1);
    this._styleResolver = this.options.style ?? null;
    this.scene.configure({
      declutter: this.options.declutter,
      visualization: this.options.visualization,
      visualizationByZoom: this.options.visualizationByZoom,
      search: this.options.search,
      time: this.options.time,
      clusterProperties: this.options.clusterProperties,
      heatmapWeight: this.options.heatmapWeight,
      heatmapDisplay: this.options.heatmapDisplay,
      heatmapIsolineLabels: this.options.heatmapIsolineLabels,
      heatmapBackend: this.options.heatmapBackend,
      heatmapEvaluation: this.options.heatmapEvaluation,
      heatmapIsolineStep: this.options.heatmapIsolineStep
    });
    this.index = new SpatialGridIndex<ManagedObject, ObjectId>(this.options.indexCellSize);
    this._render = () => this.render();
    this._scheduleRender = rafThrottle(() => this.render());
    this._scheduleLabelRedraw = rafThrottle(() => this.#redrawLabelsDuringMove());
    this._workerPool = getSharedGeometryWorkerPool();
    if (this.options.source) {
      this.add(this.options.source.getSnapshot().features.map((feature) => this.#sourceObject(feature)));
      this._sourceUnsubscribe = this.options.source.subscribe((change) => this.#applySourceChange(change));
    }
  }

  addTo(map: ObjectManagerMap): this {
    this.assertAlive();
    if ("_destroyed" in map && map._destroyed === true) throw abortError("Cannot attach ObjectManager to a destroyed map");
    if (this.map === map) return this;
    this.detach();
    this.assertAlive();
    if (this.options.clusterRenderer === "webgl" && map.crs?.code === "Simple") {
      throw new CRSCompatibilityError();
    }
    this.map = map;
    this.scene.attach(map as Orihon);
    map.on("move", this._scheduleLabelRedraw);
    map.on("zoom", this._scheduleLabelRedraw);
    map.on("moveend", this._scheduleRender);
    map.on("zoomend", this._scheduleRender);
    map.on("resize", this._scheduleRender);
    map.on("click", this._unspiderfyOnMapClick);
    map.on("unload", this.#mapUnload);
    this.render();
    return this;
  }

  /** Detach rendering/listeners while retaining data and allowing later addTo(). */
  detach(): this {
    if (!this.map) return this;
    this.map.off("unload", this.#mapUnload);
    this.map.off("move", this._scheduleLabelRedraw);
    this.map.off("zoom", this._scheduleLabelRedraw);
    this.map.off("moveend", this._scheduleRender);
    this.map.off("zoomend", this._scheduleRender);
    this.map.off("resize", this._scheduleRender);
    this.map.off("click", this._unspiderfyOnMapClick);
    this.unspiderfy();
    if (this._heatRefreshTimer) {
      clearTimeout(this._heatRefreshTimer);
      this._heatRefreshTimer = 0;
      this._heatRefreshPending = false;
    }
    this.#clearRendered();
    this.closePopup();
    this.scene.detach();
    this.map = null;
    this.#invalidateLayout();
    return this;
  }

  destroy(): this {
    if (this.#destroyed) return this;
    this.#destroyed = true;
    this.off();
    // Mark terminal before abort listeners or popup cleanup can reenter the API.
    for (const operation of this.#imports) operation.cancel();
    this.#imports.clear();
    this._sourceUnsubscribe?.();
    this._sourceUnsubscribe = null;
    this.detach();
    this.clear();
    this.scene.atlas.clear();
    this._bulkDepth = 0;
    this.#drainClusterPool();
    this._layoutGeneration++;
    // The library-owned shared pool outlives individual managers.
    this.off();
    return this;
  }

  #applySourceChange(change: FeatureSourceChange<GeoJSONFeature>): void {
    if (this.#destroyed) return;
    if (change.type === "add") {
      this.add(change.features.map((feature) => this.#sourceObject(feature)));
      return;
    }
    if (change.type === "update") {
      this.update(change.features.map((feature) => this.#sourceObject(feature)));
      return;
    }
    if (change.type === "remove") {
      this.removeObjects([...change.ids]);
      return;
    }
    const features = this.options.source?.getSnapshot().features ?? [];
    const objects = features.map((feature) => this.#sourceObject(feature));
    const nextIds = new Set(objects.map((object) => object.id).filter((id): id is ObjectId => id != null));
    const removed = [...this.items.keys()].filter((id) => !nextIds.has(id));
    const added = objects.filter((object) => object.id != null && !this.items.has(object.id));
    const updated = objects.filter((object) => object.id != null && this.items.has(object.id));
    this.beginBulk();
    try {
      if (removed.length) this.removeObjects(removed);
      if (updated.length) this.update(updated);
      if (added.length) this.add(added);
    } finally {
      this.endBulk();
    }
  }

  #sourceObject(feature: GeoJSONFeature): ManagedObject {
    return {
      ...feature,
      id: feature.id,
      geometry: (feature.geometry ?? undefined) as ManagedObject["geometry"],
      properties: feature.properties ?? undefined
    };
  }

  add(features: ManagedObject | ManagedObject[]): this {
    this.assertAlive();
    const list = Array.isArray(features) ? features : [features];
    for (const item of list) assertManagedCoordinateFormat(item);
    const cap = this.options.maxObjects;
    const skipDrop = this.markers.size === 0;
    const massPoints = !this.options.sceneFeatures;
    for (const item of list) {
      if (cap > 0 && this.items.size >= cap && (item.id == null || !this.items.has(item.id))) break;
      const id = item.id ?? globalThis.crypto?.randomUUID?.() ?? `oh-object-${++objectId}`;
      if (!skipDrop) this.#dropRenderedObject(id);
      this.items.set(id, item);
      if (massPoints) {
        const point = readManagedPoint(item);
        if (point) {
          this.index.setLatLng(id, point.lat, point.lng, item);
          this.scene.searchIndex?.upsert(id, item);
          this.scene.timeIndex?.upsert(id, item);
          continue;
        }
      }
      const normalized = this.#ingestObject(id, item);
      if (normalized?.kind === "Point") this.index.setLatLng(id, normalized.lat, normalized.lng, item);
      else if (normalized) this.index.set(id, { lat: normalized.bbox[0], lng: normalized.bbox[1] }, item);
      else this.index.delete(id);
    }
    if (this._bulkDepth === 0) {
      this.#invalidateLayout();
      this._scheduleRender();
    }
    return this;
  }

  /**
   * Cooperatively ingest a large iterable without one long main-thread task.
   * Layout invalidation/render remains suspended until the import finishes.
   * Cancellation keeps the already accepted prefix and flushes one final invalidate.
   */
  async addAsync(
    features: Iterable<ManagedObject> | AsyncIterable<ManagedObject>,
    options: ObjectManagerAsyncOptions = {}
  ): Promise<this> {
    this.assertAlive();
    const operation = new AbortableOperation("ObjectManager import", options.signal);
    const resolved = resolveAsyncBatchOptions({ ...options, signal: operation.signal }, 10_000);
    const total = Array.isArray(features) ? features.length : null;
    let processed = 0;
    let chunk: ManagedObject[] = [];
    const commit = async (final: boolean): Promise<void> => {
      operation.throwIfAborted();
      if (!chunk.length) return;
      this.add(chunk);
      processed += chunk.length;
      chunk = [];
      resolved.onProgress?.(processed, total);
      if (!final) await yieldAsyncBatch(resolved.yieldMode);
    };

    this.beginBulk();
    this.#imports.add(operation);
    try {
      return await operation.run(async () => {
        if (Array.isArray(features)) {
          for (let index = 0; index < features.length; index++) {
            throwIfAsyncAborted(resolved.signal);
            chunk.push(features[index]);
            if (chunk.length >= resolved.chunkSize) await commit(index === features.length - 1);
          }
        } else if (isAsyncIterable<ManagedObject>(features)) {
          const iterator = features[Symbol.asyncIterator]();
          let closed = false;
          const close = (): void => {
            if (closed) return;
            closed = true;
            try { void Promise.resolve(iterator.return?.()).catch(() => {}); }
            catch { /* Iterator cleanup must not replace the cancellation result. */ }
          };
          operation.signal.addEventListener("abort", close, { once: true });
          try {
            while (true) {
              operation.throwIfAborted();
              const next = await iterator.next();
              operation.throwIfAborted();
              if (next.done) { closed = true; break; }
              chunk.push(next.value);
              if (chunk.length >= resolved.chunkSize) await commit(false);
            }
          } finally {
            operation.signal.removeEventListener("abort", close);
            close();
          }
        } else {
          for (const feature of features) {
            throwIfAsyncAborted(resolved.signal);
            chunk.push(feature);
            if (chunk.length >= resolved.chunkSize) await commit(false);
          }
        }
        await commit(true);
        throwIfAsyncAborted(resolved.signal);
        return this;
      });
    } finally {
      operation.dispose();
      this.#imports.delete(operation);
      this.endBulk({ render: options.render });
    }
  }

  /**
   * Suspend layout invalidation + scheduled renders across many `add`/`update` calls.
   * Pair with `endBulk()` — required for chunked 100k–1M ingest while the manager is on the map.
   */
  beginBulk(): this {
    this.assertAlive();
    this._bulkDepth++;
    return this;
  }

  /** Flush one layout invalidate (+ optional render) after `beginBulk()`. */
  endBulk(options?: { render?: boolean }): this {
    if (this.#destroyed) return this;
    if (this._bulkDepth > 0) this._bulkDepth--;
    if (this._bulkDepth === 0) {
      this.#invalidateLayout();
      if (options?.render !== false) this._scheduleRender();
    }
    return this;
  }

  /**
   * Toggle icon/label/trail/path/polygon scene work. `false` is the mass-point fast path.
   * Re-enabling rebuilds scene geometries from stored objects.
   */
  setSceneFeatures(enabled: boolean): this {
    this.assertAlive();
    const next = Boolean(enabled);
    if (this.options.sceneFeatures === next) return this;
    this.options.sceneFeatures = next;
    if (next) {
      for (const [id, item] of this.items) {
        const normalized = tryNormalizeManagedGeometry(item, {
          maxVertices: this.options.maxVerticesPerGeometry
        });
        if (normalized) this.scene.setGeometry(id, normalized);
        else this.scene.removeGeometry(id);
      }
    } else {
      this.scene.geometries.clear();
      this.scene.resetGeometryStats();
      this.scene.dirty.clear();
      this.scene.clearNonHeatLayers();
    }
    if (this._bulkDepth === 0) this._scheduleRender();
    return this;
  }

  /**
   * In-place update of existing objects (coordinates / properties / geometry).
   * On the WebGL non-cluster path this patches GPU buffers instead of a full layout rebuild —
   * critical for realtime stress at 100k–1M.
   */
  update(features: ManagedObject | ManagedObject[], options?: { animate?: boolean; durationMs?: number }): this {
    return this.updateObjects(Array.isArray(features) ? features : [features], options);
  }

  updateObjects(
    features: Iterable<ManagedObject>,
    options?: { animate?: boolean; durationMs?: number }
  ): this {
    this.assertAlive();
    const list = [...features];
    for (const item of list) assertManagedCoordinateFormat(item);
    const animate = Boolean(options?.animate);
    rejectLegacyUnit(options ?? {}, "duration", "durationMs");
    const durationMs = nonNegativeFinite(options?.durationMs ?? 800, "durationMs");

    // Animated point moves must not rebuild cluster layout every tick.
    if (animate && this.#applyAnimatedPointUpdates(list, durationMs)) {
      return this;
    }

    // Property/style-only updates: keep spatial layout, refresh styles/scene.
    if (this.#applyPropertyOnlyUpdates(list)) {
      return this;
    }

    if (this.#canPatchWebgl()) {
      const touched: ObjectId[] = [];
      for (const item of list) {
        const id = item.id;
        if (id == null) continue;
        const prev = this.#storedPoint(id);
        const prevLat = prev?.lat ?? null;
        const prevLng = prev?.lng ?? null;
        const prevObject = this.items.get(id);
        const propertiesChanged = !prevObject || prevObject.properties !== item.properties;
        this.items.set(id, item);
        const normalized = this.#ingestObject(id, item, { skipSearch: !propertiesChanged });
        this.scene.markDirty(
          id,
          propertiesChanged
            ? ObjectDirtyFlags.Style | ObjectDirtyFlags.SearchIndex | ObjectDirtyFlags.TimeIndex
            : ObjectDirtyFlags.Position
        );
        if (!normalized || normalized.kind !== "Point") {
          this.index.delete(id);
          this.#invalidateLayout();
          this._scheduleRender();
          return this;
        }
        this.index.set(id, { lat: normalized.lat, lng: normalized.lng }, item);
        if (
          this.options.sceneFeatures &&
          prevLat != null &&
          prevLng != null &&
          (prevLat !== normalized.lat || prevLng !== normalized.lng)
        ) {
          this.scene.trails.append(id, prevLat, prevLng);
        }
        const slot = this._webglIdToIndex.get(id);
        if (slot == null) continue;
        this._webglLayer!.patchPoint(slot, normalized.lat, normalized.lng);
        const record = this.index.records.get(id);
        if (record && this._layout) this._layout.singles.set(id, record);
        const packSlot = this._webglPack?.idToIndex.get(id);
        if (this._webglPack && packSlot != null && record) {
          this._webglPack.latlng[packSlot * 2] = normalized.lat;
          this._webglPack.latlng[packSlot * 2 + 1] = normalized.lng;
          const clamped = Math.max(-85.05112878, Math.min(85.05112878, normalized.lat));
          const sin = Math.sin((clamped * Math.PI) / 180);
          this._webglPack.merc64[packSlot * 2] = (normalized.lng + 180) / 360;
          this._webglPack.merc64[packSlot * 2 + 1] = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
          this._webglPack.singles.set(id, record);
        }
        touched.push(id);
      }
      if (touched.length && this.#usesStyledWebgl()) this.#patchWebglStyles(touched);
      this._webglLayer!.render();
      if (this.options.sceneFeatures) this.#syncSceneLayers();
      return this;
    }

    for (const item of list) {
      const id = item.id;
      if (id == null) continue;
      const prev = this.#storedPoint(id);
      const prevLat = prev?.lat ?? null;
      const prevLng = prev?.lng ?? null;
      const prevObject = this.items.get(id);
      const propertiesChanged = !prevObject || prevObject.properties !== item.properties;
      this.items.set(id, item);
      const normalized = this.#ingestObject(id, item, { skipSearch: !propertiesChanged });
      this.index.delete(id);
      if (normalized?.kind === "Point") {
        this.index.set(id, { lat: normalized.lat, lng: normalized.lng }, item);
        if (
          this.options.sceneFeatures &&
          prevLat != null &&
          prevLng != null &&
          (prevLat !== normalized.lat || prevLng !== normalized.lng)
        ) {
          this.scene.trails.append(id, prevLat, prevLng);
        }
      } else if (normalized) {
        this.index.set(id, { lat: normalized.bbox[0], lng: normalized.bbox[1] }, item);
      }
      this.scene.markDirty(
        id,
        propertiesChanged
          ? ObjectDirtyFlags.Style | ObjectDirtyFlags.SearchIndex | ObjectDirtyFlags.TimeIndex | ObjectDirtyFlags.Geometry
          : ObjectDirtyFlags.Position
      );
    }
    this.#invalidateLayout();
    this._scheduleRender();
    return this;
  }

  /**
   * Fast path when geometry is unchanged and only properties/style inputs changed.
   */
  #applyPropertyOnlyUpdates(list: ManagedObject[]): boolean {
    if (!list.length) return false;
    const touched: ObjectId[] = [];
    for (const item of list) {
      const id = item.id;
      if (id == null) return false;
      const prev = this.items.get(id);
      if (!prev) return false;
      const nextGeom = tryNormalizeManagedGeometry(item, {
        maxVertices: this.options.maxVerticesPerGeometry
      });
      if (!nextGeom) return false;
      if (nextGeom.kind === "Point") {
        const stored = this.#storedPoint(id);
        if (!stored || stored.lat !== nextGeom.lat || stored.lng !== nextGeom.lng) return false;
      } else {
        const prevGeom = this.scene.geometries.get(id);
        if (!prevGeom || prevGeom.kind === "Point" || prevGeom.kind !== nextGeom.kind) return false;
        if (
          prevGeom.bbox[0] !== nextGeom.bbox[0] ||
          prevGeom.bbox[1] !== nextGeom.bbox[1] ||
          prevGeom.bbox[2] !== nextGeom.bbox[2] ||
          prevGeom.bbox[3] !== nextGeom.bbox[3]
        ) {
          return false;
        }
      }
      this.items.set(id, item);
      this.#ingestObject(id, item, { skipSearch: false });
      this.scene.markDirty(id, ObjectDirtyFlags.Style | ObjectDirtyFlags.SearchIndex | ObjectDirtyFlags.TimeIndex);
      touched.push(id);
    }
    if (this.#canPatchWebgl() && this.#usesStyledWebgl()) {
      this.#patchWebglStyles(touched);
      this._webglLayer!.render();
    }
    if (this.options.sceneFeatures) this.#syncSceneLayers();
    // Heat weights often come from properties — refresh the field without waiting for moveend.
    this.#refreshHeatmapIfActive();
    if (!this.#canPatchWebgl()) this._scheduleRender();
    return true;
  }

  /**
   * Fast path for animated point moves: update indexes + GPU motion attrs,
   * never rebuild cluster hierarchy mid-flight.
   */
  #applyAnimatedPointUpdates(list: ManagedObject[], durationMs: number): boolean {
    if (!this.map || !list.length) return false;
    let applied = 0;
    const headingPatches: Array<{ id: ObjectId; rotation: number }> = [];
    for (const item of list) {
      const id = item.id;
      if (id == null) continue;
      const stored = this.#storedPoint(id);
      if (!stored) return false;
      const prevObject = this.items.get(id);
      const propertiesChanged = !prevObject || prevObject.properties !== item.properties;
      const prevLat = stored.lat;
      const prevLng = stored.lng;
      this.items.set(id, item);
      const normalized = this.#ingestObject(id, item, { skipSearch: !propertiesChanged });
      if (!normalized || normalized.kind !== "Point") return false;
      this.index.set(id, { lat: normalized.lat, lng: normalized.lng }, item);
      const record = this.index.records.get(id);
      if (record && this._layout?.singles.has(id)) this._layout.singles.set(id, record);
      if (this.options.sceneFeatures) {
        this.scene.startMotion(id, prevLat, prevLng, normalized.lat, normalized.lng, durationMs);
        this.scene.trails.append(id, prevLat, prevLng);
      }

      const slot = this._webglIdToIndex.get(id);
      if (slot != null && this._webglLayer) {
        this._webglLayer.patchPoint(slot, normalized.lat, normalized.lng);
      }
      if (typeof item.properties?.heading === "number") {
        headingPatches.push({ id, rotation: Number(item.properties.heading) });
      }
      applied += 1;
    }
    if (!applied) return false;
    if (this.options.sceneFeatures) {
      this.scene.patchSymbolMotions(headingPatches);
      if (this.scene.symbolLayer) this.scene.symbolLayer.render();
      else this.#syncSceneLayers();
    }
    // Mass path (sceneFeatures:false): patchPoint uploads GPU buffers but does not draw.
    // Without an explicit render the map stays frozen until the next camera frame.
    if (this._webglLayer) this._webglLayer.render();
    return true;
  }

  moveObject(
    id: ObjectId,
    coordinates: LatLngLike,
    options?: { animate?: boolean; durationMs?: number }
  ): this {
    this.assertAlive();
    const object = this.items.get(id);
    if (!object) throw new RangeError(`ObjectManager: object "${String(id)}" does not exist`);
    return this.updateObjects([{ ...object, id, coordinates }], options);
  }

  removeObjects(ids: ObjectId | ObjectId[]): this {
    this.assertAlive();
    this.unspiderfy();
    this.closePopup();
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      this.items.delete(id);
      this.index.delete(id);
      this.objectStates.delete(id);
      this.scene.removeObject(id);
      if (this._selectedId === id) this._selectedId = null;
      if (this._hoveredId === id) this._hoveredId = null;
      this.#dropRenderedObject(id);
    }
    this.#invalidateLayout();
    this._scheduleRender();
    return this;
  }

  getObject(id: ObjectId): ManagedObject | undefined { return this.items.get(id); }

  getObjects(): ManagedObject[] { return [...this.items.values()]; }

  setFilter(filter: ObjectFilter | null): this {
    this.assertAlive();
    this.unspiderfy();
    this.filter = filter;
    this._gpuSubset = false;
    this._leafMask = null;
    this._leafMaskFilter = undefined;
    this._leafMaskIndex = null;
    // WebGL + no clusters: rebuild the GPU list from the spatial index without greedy layout.
    if (this.map && this.#shouldUseWebgl() && !this.options.clusterize) {
      this.#fastWebglFilterSync();
      return this;
    }
    // Keep the zoom hierarchy. Filter is a query over the same tree — dropping the
    // index here restarts a 100k–1M recluster on every setFilter (bench FPS collapse).
    if (this._clusterIndex) {
      this._layoutDirty = true;
      this._scheduleRender();
      return this;
    }
    this._layoutDirty = true;
    this._layoutPackDirty = true;
    this._greedyCache.clear();
    if (this._layout && this.index.size >= this._greedyZoomInlineLimit) {
      this._scheduleRender();
      return this;
    }
    this.#invalidateLayout();
    this._scheduleRender();
    return this;
  }

  /**
   * Restrict the WebGL draw list to these ids (O(k) from the packed buffer).
   * Pass `null` to restore every packed point. No layout rebuild.
   */
  setVisibleIds(ids: Iterable<ObjectId> | null): this {
    this.assertAlive();
    if (!this.map || !this.#shouldUseWebgl() || this.options.clusterize) {
      return this;
    }
    if (ids == null) {
      this._gpuSubset = false;
      if (this._webglPack && this._webglLayer) {
        this.#applyWebglPack(this._webglPack, Math.floor(this.map.zoom), false);
      } else {
        this.#fastWebglFilterSync();
      }
      this._webglLayer?.setHidden(false);
      return this;
    }
    this._gpuSubset = true;
    this.#applyWebglIdSubset(ids);
    return this;
  }

  getSelectedId(): ObjectId | null {
    return this._selectedId;
  }

  setSelected(id: ObjectId | null): this {
    this.assertAlive();
    const next = id == null ? null : id;
    if (next != null && !this.items.has(next)) {
      throw new RangeError(`ObjectManager: object "${String(next)}" does not exist`);
    }
    if (this._selectedId === next) return this;
    const prev = this._selectedId;
    const touched: ObjectId[] = [];
    if (prev != null) {
      this.#writeStateFlag(prev, "selected", false);
      touched.push(prev);
    }
    this._selectedId = next;
    if (next != null) {
      this.#writeStateFlag(next, "selected", true);
      touched.push(next);
    }
    this.#afterVisualStateChange(touched);
    return this;
  }

  getHoveredId(): ObjectId | null {
    return this._hoveredId;
  }

  setHovered(id: ObjectId | null): this {
    this.assertAlive();
    const next = id == null ? null : id;
    if (next != null && !this.items.has(next)) {
      throw new RangeError(`ObjectManager: object "${String(next)}" does not exist`);
    }
    if (this._hoveredId === next) return this;
    const prev = this._hoveredId;
    const touched: ObjectId[] = [];
    if (prev != null) {
      this.#writeStateFlag(prev, "hovered", false);
      touched.push(prev);
    }
    this._hoveredId = next;
    if (next != null) {
      this.#writeStateFlag(next, "hovered", true);
      touched.push(next);
    }
    this.#afterVisualStateChange(touched);
    return this;
  }

  getObjectState(id: ObjectId): Readonly<ObjectState> {
    const state = this.objectStates.get(id);
    return state ? { ...state } : {};
  }

  setObjectState(id: ObjectId, state: Partial<ObjectState>): this {
    this.assertAlive();
    this.#assertObjectExists(id);
    const { changedKeys, sideTouched } = this.#mergeObjectState(id, state);
    if (!changedKeys.length) return this;
    this.emit("objectstatechange", {
      id,
      state: this.getObjectState(id),
      changedKeys
    });
    this.#afterVisualStateChange([id, ...sideTouched]);
    return this;
  }

  setObjectStates(updates: Iterable<{ id: ObjectId; state: Partial<ObjectState> }>): this {
    this.assertAlive();
    const touched = new Set<ObjectId>();
    for (const update of updates) {
      this.#assertObjectExists(update.id);
      const { changedKeys, sideTouched } = this.#mergeObjectState(update.id, update.state);
      if (!changedKeys.length) continue;
      touched.add(update.id);
      for (const id of sideTouched) touched.add(id);
      this.emit("objectstatechange", {
        id: update.id,
        state: this.getObjectState(update.id),
        changedKeys
      });
    }
    if (touched.size) this.#afterVisualStateChange([...touched]);
    return this;
  }

  removeObjectState(id: ObjectId, keys?: keyof ObjectState | Array<keyof ObjectState>): this {
    this.assertAlive();
    this.#assertObjectExists(id);
    const current = this.objectStates.get(id);
    if (!current) return this;
    const changedKeys: string[] = [];
    if (keys == null) {
      changedKeys.push(...Object.keys(current));
      this.objectStates.delete(id);
      if (this._selectedId === id) this._selectedId = null;
      if (this._hoveredId === id) this._hoveredId = null;
    } else {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        const name = String(key);
        if (!(name in current)) continue;
        delete current[name];
        changedKeys.push(name);
        if (name === "selected" && this._selectedId === id) this._selectedId = null;
        if (name === "hovered" && this._hoveredId === id) this._hoveredId = null;
      }
      if (!Object.keys(current).length) this.objectStates.delete(id);
    }
    if (!changedKeys.length) return this;
    this.emit("objectstatechange", {
      id,
      state: this.getObjectState(id),
      changedKeys
    });
    this.#afterVisualStateChange([id]);
    return this;
  }

  clearObjectStates(): this {
    this.assertAlive();
    if (!this.objectStates.size && this._selectedId == null && this._hoveredId == null) return this;
    const touched = [...this.objectStates.keys()];
    if (this._selectedId != null && !touched.includes(this._selectedId)) touched.push(this._selectedId);
    if (this._hoveredId != null && !touched.includes(this._hoveredId)) touched.push(this._hoveredId);
    this.objectStates.clear();
    this._selectedId = null;
    this._hoveredId = null;
    for (const id of touched) {
      this.emit("objectstatechange", {
        id,
        state: {},
        changedKeys: ["*"]
      });
    }
    this.#afterVisualStateChange(touched);
    return this;
  }

  setStyle(style: ObjectStyleResolver | null): this {
    this.assertAlive();
    const next = style ?? null;
    if (this._styleResolver === next) return this;
    this._styleResolver = next;
    this.options.style = next;
    this.emit("stylechange", { style: next });
    this._styleZoom = null;
    if (this.#canPatchWebgl() && this.#usesStyledWebgl()) {
      this.#refreshWebglStyles();
      this._webglLayer!.render();
    } else {
      this.#refreshWebglStyles();
      this._scheduleRender();
    }
    for (const [markerId, marker] of this.markers) {
      const object = this.items.get(markerId);
      if (object) this.#paintDomMarker(marker, markerId, object);
    }
    return this;
  }

  registerIcon(name: string, source: ManagedIconSource, options?: ManagedIconOptions): this {
    this.assertAlive();
    this.scene.registerIcon(name, source, options);
    this.emit("iconregister", { name });
    this._scheduleRender();
    return this;
  }

  removeIcon(name: string): this {
    this.assertAlive();
    this.scene.removeIcon(name);
    this.emit("iconremove", { name });
    this._scheduleRender();
    return this;
  }

  hasIcon(name: string): boolean {
    return this.scene.hasIcon(name);
  }

  clearIcons(): this {
    this.assertAlive();
    this.scene.clearIcons();
    this._scheduleRender();
    return this;
  }

  search(query: string, options?: ObjectSearchOptions): ObjectSearchResult[] {
    return this.scene.search(query, this.items, options);
  }

  setTime(timestamp: number | null): this {
    return this.setTimeRange(timestamp, timestamp);
  }

  setTimeRange(from: number | null, to: number | null): this {
    this.assertAlive();
    this.scene.setTimeRange(from, to);
    this.emit("timerangechange", { from, to });
    if (this.map && this.#shouldUseWebgl() && !this.options.clusterize) {
      this.#fastWebglFilterSync();
      if (this.options.sceneFeatures) this.#syncSceneLayers();
      return this;
    }
    this._scheduleRender();
    return this;
  }

  setVisualization(mode: ObjectVisualizationMode): this {
    this.assertAlive();
    if (this.options.visualization === mode) return this;
    this.options.visualization = mode;
    this.scene.visualization = mode;
    this.emit("visualizationchange", { visualization: mode });
    this._scheduleRender();
    return this;
  }

  focusObject(id: ObjectId, options?: { zoom?: number; animate?: boolean }): this {
    this.assertAlive();
    const object = this.items.get(id);
    const position = object ? this.#objectPosition(object) : null;
    if (!object || !position || !this.map) return this;
    const zoom = options?.zoom ?? Math.max(this.map.zoom, 14);
    this.map.setView(position, zoom);
    this.setSelected(id);
    return this;
  }

  bindPopup(content: ObjectPopupContent, options?: PopupOptions): this {
    this.assertAlive();
    this._popupBinding = { content, options };
    return this;
  }

  unbindPopup(): this {
    this._popupBinding = null;
    this.closePopup();
    return this;
  }

  bindClusterPopup(content: ClusterPopupContent, options?: PopupOptions): this {
    this.assertAlive();
    this._clusterPopupBinding = { content, options };
    return this;
  }

  unbindClusterPopup(): this {
    this._clusterPopupBinding = null;
    this.closePopup();
    return this;
  }

  openPopup(id: ObjectId): this {
    this.assertAlive();
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
    this.assertAlive();
    if (this.options.clusterize === Boolean(enabled)) return this;
    this.options.clusterize = Boolean(enabled);
    this.unspiderfy();
    this._gpuSubset = false;
    this.#invalidateLayout(false);
    this.#clearDomClusters();
    this.#clearClusterCanvas();
    if (!enabled) {
      this._webglLayer?.setHidden(false);
      if (this._webglPack && this._webglLayer && this.map) {
        this.#applyWebglPack(this._webglPack, Math.floor(this.map.zoom), true);
        this.scene.clearHeat();
        return this;
      }
    }
    this._scheduleRender();
    return this;
  }

  setClusterRadiusPixels(radiusPixels: number): this {
    this.assertAlive();
    const next = Math.max(20, nonNegativeFinite(radiusPixels, "clusterRadiusPixels"));
    if (this.options.clusterRadiusPixels === next) return this;
    this.options.clusterRadiusPixels = next;
    this.unspiderfy();
    this.#invalidateLayout();
    this.#clearRendered();
    this._scheduleRender();
    return this;
  }

  setClusterRenderer(renderer: ClusterRenderer): this {
    this.assertAlive();
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
    this.objectStates.clear();
    this.scene.clear();
    this._selectedId = null;
    this._hoveredId = null;
    this._styleZoom = null;
    this._visibleObjects = 0;
    this._layout = null;
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
      layoutZoom: this._layout?.zoomBucket ?? null,
      clusterStrategy: !this.options.clusterize
        ? "none"
        : this._clusterIndex
          ? "hierarchy"
          : "greedy"
    };
  }

  queryHit(point: Point, options: ResolvedQueryOptions): QueryHit | QueryHit[] | null {
    const hits: QueryHit[] = [];
    const clusterHit = this._clusterCanvas?.queryHit(point, options);
    if (clusterHit) {
      const clusterId = String(clusterHit.id);
      hits.push({ ...clusterHit, source: "cluster", feature: this.#clusterMemberIds(clusterId) });
    }
    const symbolHit = this.scene.symbolLayer?.queryHit(point, options);
    if (symbolHit) {
      hits.push({
        ...symbolHit,
        source: "object",
        id: symbolHit.id,
        feature: symbolHit.id != null ? this.items.get(symbolHit.id) : symbolHit.feature
      });
    }
    const polygonHit = this.scene.polygonBatch?.queryHit(point, options);
    if (polygonHit) {
      hits.push({
        ...polygonHit,
        source: "object",
        id: polygonHit.id,
        feature: polygonHit.id != null ? this.items.get(polygonHit.id) : undefined
      });
    }
    const pathHit = this.scene.pathBatch?.queryHit?.(point, options);
    if (pathHit) {
      hits.push({
        ...pathHit,
        source: "object",
        id: pathHit.id,
        feature: pathHit.id != null ? this.items.get(pathHit.id) : undefined
      });
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
    this.assertAlive();
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
    if (this.#destroyed) return;
    const map = this.map;
    if (!map) return;
    if (map.zoom < this.options.minZoom) {
      this._visibleObjects = 0;
      this.#clearRendered();
      this.emit("render", { stats: this.getStats() });
      return;
    }

    const visualization = this.scene.resolveVisualization(map.zoom);
    const changedViz = this.scene.setActiveVisualization(visualization);
    if (changedViz) this.emit("visualizationchange", { visualization });

    if (visualization === "heatmap") {
      this.#clearObjectMarkers();
      this.#clearDomClusters();
      this.#clearClusterCanvas();
      this.scene.clearNonHeatLayers();
      this.#syncHeatmap();
      // Optional points under the field (≤80k). Honor setVisibleIds([]) so demos
      // can keep heat/isolines without the marker cloud.
      if (this.#shouldUseWebgl() && this.items.size <= 80_000) {
        const layout = this.#ensureLayout(map);
        this.#syncWebgl(layout);
        const hidePoints = this._gpuSubset && this._webglIdToIndex.size === 0;
        this._webglLayer?.setHidden(hidePoints);
      } else {
        this._webglLayer?.setHidden(true);
      }
      this.emit("render", { stats: this.getStats() });
      return;
    }

    // Leaving heatmap must drop the heat layer so it does not stack on clusters/objects.
    this.scene.clearHeat();
    this._webglLayer?.setHidden(false);

    const layout = this.#ensureLayout(map);
    const useClusters =
      visualization === "clusters" || (visualization === "objects" && this.options.clusterize);
    const useWebgl = this.#shouldUseWebgl() && (visualization === "objects" || visualization === "clusters");
    const useCanvasClusters = this.#useCanvasClusters();
    this._activeRenderer = useWebgl ? "webgl" : "dom";

    const area = bounds(map.getBounds()).pad(0.15);
    const timeActive = this.scene.activeTimeIds();

    if (useWebgl) {
      this.#clearObjectMarkers();
      if (useClusters) {
        const clusterSpecs = this.#pickClusterSpecs(layout, area);
        this.#filterClusterSpecsByTime(clusterSpecs, timeActive);
        this._visibleObjects = this.#countVisibleFromLayout(layout, area, clusterSpecs);
        this.#syncWebgl(layout);
        if (useCanvasClusters) {
          this.#clearDomClusters();
          this.#syncCanvasClusters(clusterSpecs);
        } else {
          this.#clearClusterCanvas();
          this.#syncClusters(clusterSpecs, layout);
        }
      } else {
        this.#clearClusterCanvas();
        this.#clearDomClusters();
        this.#syncWebgl(layout);
        this._visibleObjects = this._webglIdToIndex.size || layout.singles.size;
      }
      this.#syncSceneLayers();
      this.emit("render", { stats: this.getStats() });
      return;
    }

    const visibleIds = new Set(
      this.index.searchIds(area, (id, value) => {
        if (timeActive && !timeActive.has(id)) return false;
        return !this.filter || this.filter(value, id);
      })
    );
    this._visibleObjects = visibleIds.size;
    const clusterSpecs = this.#pickClusterSpecs(layout, area, visibleIds);
    this.#filterClusterSpecsByTime(clusterSpecs, timeActive);

    const markerRecords = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
    for (const [id, record] of layout.singles) {
      if (visibleIds.has(id)) markerRecords.set(id, record);
    }

    this.#clearWebgl();
    this.#clearClusterCanvas();
    this.scene.heatLayer?.remove();
    this.scene.heatLayer = null;
    if (this.options.sceneFeatures && (this.scene.atlas.size > 0 || this.scene.hasNonPointGeometries())) {
      for (const [id, record] of [...markerRecords]) {
        const geometry = this.scene.geometries.get(id);
        if (geometry && geometry.kind !== "Point") {
          markerRecords.delete(id);
          continue;
        }
        const resolved = this.#resolveObjectStyle(id, record.value, "dom");
        if (resolved.icon) markerRecords.delete(id);
      }
    }
    this.#syncObjectMarkers(markerRecords);
    this.#syncClusters(clusterSpecs, layout);
    this.#syncSceneLayers();
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
    area: LatLngBounds,
    clusterSpecs: Map<string, ClusterSpec>
  ): number {
    let total = 0;
    for (const spec of clusterSpecs.values()) total += spec.count || spec.ids.length;
    for (const record of layout.singles.values()) {
      if (area.contains(record.position)) total += 1;
    }
    return total;
  }

  /**
   * Paint clusters for the current (or given) zoom quickly, then build the zoom hierarchy
   * in the background (worker when enabled). Zoom changes use the index once it is ready.
   */
  async prepareLayout(zoom?: number): Promise<this> {
    this.assertAlive();
    // Flat WebGL mass markers: skip greedy singles allocation (huge win at 1M).
    if (this.#shouldUseWebgl() && !this.options.clusterize) {
      const zoomBucket = Math.floor(zoom ?? this.map?.zoom ?? 0);
      this.#buildFlatLayout(zoomBucket);
      if (this.map) {
        this.render();
      }
      this.assertAlive();
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
    this.assertAlive();
    if (generation !== this._layoutGeneration) return this;

    if (!request.clusterize || request.ids.length === 0) {
      this._clusterIndex = null;
      return this;
    }

    if (!this.#shouldBuildClusterHierarchy(request.ids.length)) return this;

    // Small sets: finish hierarchy inline so tests/popups see a stable tree immediately.
    if (request.ids.length < this._greedyZoomInlineLimit) {
      const index = buildClusterIndex(request);
      if (generation !== this._layoutGeneration) return this;
      this._clusterIndex = index;
      this._greedyCache.clear();
      this.#applyLayoutResult(zoomBucket, this.#queryClusterIndex(index, zoomBucket));
      if (this.map) this.render();
      this.assertAlive();
      return this;
    }

    // Defer hierarchy so Worker blob compile / heavy sync build never blocks first paint.
    const task = new Promise<void>((resolve, reject) => {
      deferClusterHierarchy(() => {
        this.#buildHierarchy(request, generation, zoomBucket).then(resolve, reject);
      });
    });
    const settled = task.finally(() => {
      if (this._layoutPromise === settled) this._layoutPromise = null;
    });
    this._layoutPromise = settled;
    void settled.catch((error) => {
      if (!this.#destroyed && generation === this._layoutGeneration) this.emit("error", { error, phase: "layout" });
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
      __datasetVersion?: number;
    },
    generation: number,
    zoomBucket: number
  ): Promise<void> {
    if (this.#destroyed || generation !== this._layoutGeneration) return;
    const index = this.#shouldUseLayoutWorker()
      ? await this._workerPool.clusterIndex(request)
      : await new Promise<ClusterIndex>((resolve, reject) => {
          setTimeout(() => {
            if (this.#destroyed || generation !== this._layoutGeneration) { reject(abortError("ObjectManager layout was cancelled")); return; }
            try { resolve(buildClusterIndex(request)); }
            catch (error) { reject(error); }
          }, 0);
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
        this.#applyLayoutResult(liveZoom, this.#queryClusterIndex(index, liveZoom));
        this._scheduleRender();
      });
      return;
    }
    this.#applyLayoutResult(z, this.#queryClusterIndex(index, z));
    if (this.map) this.render();
  }

  #shouldUseLayoutWorker(): boolean {
    if (this.map?.crs?.code === "Simple") return false;
    const mode = this.options.layoutWorker;
    if (mode === true) return true;
    if (mode === false) return false;
    return this.index.size >= this.options.layoutWorkerThreshold;
  }

  #shouldBuildClusterHierarchy(count: number): boolean {
    const limit = this.options.clusterHierarchyMaxObjects;
    return limit === 0 || count <= limit;
  }

  #collectLayoutRequest(zoomBucket: number) {
    this.#syncLayoutPack();
    return {
      ids: this._layoutIds,
      coords: this._layoutCoords.subarray(0, this._layoutPacked * 2),
      zoomBucket,
      gridSize: this.options.clusterRadiusPixels,
      minPoints: this.options.clusterMinPoints,
      clusterize: this.options.clusterize,
      clusterMaxZoom: this.options.clusterMaxZoom,
      simple: this.map?.crs?.code === "Simple",
      __datasetVersion: this._layoutDatasetVersion
    };
  }

  #syncLayoutPack(): void {
    if (!this._layoutPackDirty) return;
    const need = this.index.size;
    if (this._layoutCoords.length < need * 2) this._layoutCoords = new Float64Array(Math.max(need * 2, 16));
    if (this._layoutIds.length < need) this._layoutIds.length = need;
    let packed = 0;
    for (const record of this.index.records.values()) {
      this._layoutIds[packed] = record.id;
      this._layoutCoords[packed * 2] = record.position.lat;
      this._layoutCoords[packed * 2 + 1] = record.position.lng;
      packed++;
    }
    this._layoutIds.length = packed;
    this._layoutPacked = packed;
    this._layoutPackDirty = false;
    this._layoutDatasetVersion += 1;
  }

  #queryClusterIndex(index: ClusterIndex, zoomBucket: number): ClusterLayoutResult {
    return queryClusterLayout(index, zoomBucket, this.options.clusterMinPoints, {
      expandLeaves: false,
      leafMask: this.#clusterLeafMask(index)
    });
  }

  #clusterLeafMask(index: ClusterIndex): Uint8Array | null {
    if (!this.filter) return null;
    if (this._leafMask && this._leafMaskFilter === this.filter && this._leafMaskIndex === index) {
      return this._leafMask;
    }
    const mask = new Uint8Array(index.leafCount);
    const filter = this.filter;
    const ids = index.ids;
    for (let i = 0; i < index.leafCount; i++) {
      const id = ids[i];
      const object = this.items.get(id);
      if (object && filter(object, id)) mask[i] = 1;
    }
    this._leafMask = mask;
    this._leafMaskFilter = filter;
    this._leafMaskIndex = index;
    return mask;
  }

  #applyLayoutResult(zoomBucket: number, result: ClusterLayoutResult): void {
    const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
    const clusters = new Map<string, ClusterSpec>();

    for (const single of result.singles) {
      const value = this.items.get(single.id);
      if (!value) continue;
      singles.set(single.id, {
        id: single.id,
        position: latLng({ lat: single.lat, lng: single.lng }),
        value
      });
    }
    for (const cluster of result.clusters) {
      clusters.set(cluster.key, {
        position: latLng({ lat: cluster.lat, lng: cluster.lng }),
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

  #invalidateLayout(dropPack = true): void {
    this._clusterIndex = null;
    this._layoutDirty = true;
    this._webglSyncedZoom = null;
    if (dropPack) {
      this._webglPack = null;
      this._gpuSubset = false;
    }
    this._webglDataEpoch++;
    this._clusterSyncZoom = null;
    this._clusterSyncGeneration = -1;
    this._layoutGeneration++;
    this._layoutPromise = null;
    this._greedyPromise = null;
    this._greedyCache.clear();
    this._pendingGreedyZoom = null;
    this._layoutPackDirty = true;
    this._leafMask = null;
    this._leafMaskFilter = undefined;
    this._leafMaskIndex = null;
    if (this._greedyRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._greedyRaf);
      this._greedyRaf = 0;
    }
  }

  /** Coalesce expensive pre-hierarchy reclusters onto the latest zoom only. */
  #scheduleGreedyForZoom(zoomBucket: number): void {
    if (this.#destroyed) return;
    this._pendingGreedyZoom = zoomBucket;
    if (this._greedyRaf || this._greedyPromise) return;
    const run = () => {
      if (this.#destroyed) return;
      this._greedyRaf = 0;
      const target = this._pendingGreedyZoom;
      this._pendingGreedyZoom = null;
      if (target == null || this._clusterIndex) return;
      if (!this._layoutDirty && this._layout?.zoomBucket === target) return;
      const cached = this._greedyCache.get(target);
      if (cached && !this._layoutDirty) {
        this.#applyLayoutResult(target, cached);
        this._scheduleRender();
        return;
      }
      const request = this.#collectLayoutRequest(target);
      if (this.#shouldUseLayoutWorker() && request.ids.length >= this._greedyZoomInlineLimit) {
        const generation = this._layoutGeneration;
        const task = this._workerPool.greedyClusterLayout(request).then((result) => {
          if (generation !== this._layoutGeneration || this._clusterIndex) return;
          this.#rememberGreedy(target, result);
          const liveZoom = Math.floor(this.map?.zoom ?? target);
          if (liveZoom === target) {
            this.#applyLayoutResult(target, result);
            this._scheduleRender();
          }
        });
        const settled = task.finally(() => {
          if (this._greedyPromise === settled) this._greedyPromise = null;
          if (this._pendingGreedyZoom != null) this.#scheduleGreedyForZoom(this._pendingGreedyZoom);
        });
        this._greedyPromise = settled;
        void settled.catch((error) => {
          if (!this.#destroyed && generation === this._layoutGeneration) this.emit("error", { error, phase: "layout" });
        });
        return;
      }
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
    area: LatLngBounds,
    visibleIds?: Set<ObjectId>
  ): Map<string, ClusterSpec> {
    // World-stable keys: when the full set is modest, keep every badge mounted so pan
    // does not thrash DOM create/remove. Canvas path also benefits from drawing all
    // modest sets without per-pan churn of setClusters identity.
    if (layout.clusters.size <= this._clusterDomBudget) return layout.clusters;
    const clusterSpecs = new Map<string, ClusterSpec>();
    for (const [key, spec] of layout.clusters) {
      if (area.contains(spec.position)) {
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

    if (this._clusterIndex) {
      this.#applyLayoutResult(zoomBucket, this.#queryClusterIndex(this._clusterIndex, zoomBucket));
      return this._layout!;
    }

    // Pre-hierarchy zoom/filter: never stall the frame with another full O(n) greedy pass
    // on large datasets. Show the last layout (or a cache hit) and coalesce a rebuild.
    if (this._layout && this.index.size >= this._greedyZoomInlineLimit) {
      const cached = this._greedyCache.get(zoomBucket);
      if (cached && !this._layoutDirty) {
        this.#applyLayoutResult(zoomBucket, cached);
        return this._layout!;
      }
      this.#scheduleGreedyForZoom(zoomBucket);
      return this._layout;
    }

    if (!this._layoutDirty && this._layout) {
      const cached = this._greedyCache.get(zoomBucket);
      if (cached) {
        this.#applyLayoutResult(zoomBucket, cached);
        return this._layout!;
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

    if (
      request.clusterize &&
      request.ids.length > 0 &&
      this.#shouldBuildClusterHierarchy(request.ids.length) &&
      !this._layoutPromise
    ) {
      if (request.ids.length < this._greedyZoomInlineLimit) {
        const index = buildClusterIndex(request);
        this._clusterIndex = index;
        this._greedyCache.clear();
        this.#applyLayoutResult(zoomBucket, this.#queryClusterIndex(index, zoomBucket));
      } else {
        const generation = this._layoutGeneration;
        const task = new Promise<void>((resolve, reject) => {
          deferClusterHierarchy(() => {
            this.#buildHierarchy(request, generation, zoomBucket).then(resolve, reject);
          });
        });
        const settled = task.finally(() => {
          if (this._layoutPromise === settled) this._layoutPromise = null;
        });
        this._layoutPromise = settled;
        void settled.catch((error) => {
          if (!this.#destroyed && generation === this._layoutGeneration) this.emit("error", { error, phase: "layout" });
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
      this.#paintDomMarker(created, id, record.value);
      this.markers.set(id, created);
    }
  }

  #paintDomMarker(marker: Marker, id: ObjectId, object: ManagedObject): void {
    const el = marker.el;
    if (!el) return;
    const cat = String(object.properties?.category || "alpha");
    const selected = this._selectedId === id;
    const hovered = this._hoveredId === id;
    el.classList.toggle("oh-om-alpha", cat === "alpha");
    el.classList.toggle("oh-om-beta", cat === "beta");
    el.classList.toggle("oh-om-gamma", cat === "gamma");
    el.classList.toggle("oh-om-alert", Boolean(object.properties?.alert));
    el.classList.toggle("oh-om-selected", selected);
    el.classList.toggle("oh-om-hover", hovered);
    if (!this._styleResolver) return;
    const resolved = this.#resolveObjectStyle(id, object, "dom");
    el.style.setProperty("--oh-om-color", resolved.color);
    el.style.setProperty("--oh-marker-fill", resolved.color);
    el.style.opacity = String(resolved.opacity);
    const pin = el.querySelector(".oh-marker-pin") as HTMLElement | null;
    if (pin) {
      pin.style.setProperty("--oh-marker-fill", resolved.color);
      pin.style.setProperty("--oh-marker-size", `${resolved.size}px`);
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
    (event.originalEvent as Event | undefined)?.stopPropagation();
    const key = String(event.clusterKey ?? "");
    if (!key) return;
    const latlng = (event.latlng as LatLngLike) || this._layout?.clusters.get(key)?.position;
    if (!latlng) return;
    this.#clusterClickAt(key, latlng, event);
  }

  #syncWebgl(layout: LayoutCache): void {
    if (!this.map) return;
    if (this._gpuSubset && this._webglLayer) return;
    const zoomBucket = layout.zoomBucket;
    const topologyMatches = this.#webglTopologyMatches(layout);
    const viewKey = this.#flatViewKey();
    if (
      this._webglLayer &&
      topologyMatches &&
      !this._layoutDirty &&
      this._webglSyncedEpoch === this._webglDataEpoch &&
      this._webglViewKey === viewKey
    ) {
      const zoomChanged = this._webglSyncedZoom !== zoomBucket;
      this._webglSyncedZoom = zoomBucket;
      // Mass flat WebGL: skip walking 250k–1M style callbacks on every integer zoom.
      if (zoomChanged && this._styleResolver && (this.options.clusterize || this.index.size < 250_000)) {
        this.#refreshWebglStyles();
        this._styleZoom = zoomBucket;
      }
      return;
    }

    const syncStarted = perfNow();
    const timeActive = this.scene.activeTimeIds();
    const count = layout.singles.size;
    const fullFlatMassPack = !this.filter && !timeActive && !this.options.sceneFeatures;

    const packStarted = perfNow();
    const packAllocateStarted = perfNow();
    const meta: WebGLMeta[] = new Array(count);
    const latlng = new Float32Array(count * 2);
    const merc64 = new Float64Array(count * 2);
    const packAllocateMs = perfNow() - packAllocateStarted;
    let idToIndex: WebGLIdIndex;
    let denseIdIndex = false;
    let i = 0;
    const packFillStarted = perfNow();

    if (fullFlatMassPack) {
      // Common 100k–1M point path: every spatial record is renderable. Avoid one
      // private-method call plus filter/time/geometry branches for every object.
      // Start in the zero-storage dense-id mode. If the first non slot-aligned id
      // appears, lazily materialize a Map and backfill only the already-seen slots.
      let denseIds = true;
      let sparseIdToIndex: Map<ObjectId, number> | null = null;
      for (const [id, record] of layout.singles) {
        if (denseIds && id !== i) {
          denseIds = false;
          sparseIdToIndex = new Map<ObjectId, number>();
          for (let slot = 0; slot < i; slot++) sparseIdToIndex.set(slot, slot);
        }
        if (!denseIds) sparseIdToIndex!.set(id, i);
        meta[i] = { kind: "object", id };
        const lat = record.position.lat;
        const lng = record.position.lng;
        const o = i * 2;
        latlng[o] = lat;
        latlng[o + 1] = lng;
        const sin = Math.sin((clampLat(lat) * Math.PI) / 180);
        merc64[o] = (wrapLng(lng) + 180) / 360;
        merc64[o + 1] = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
        i++;
      }
      denseIdIndex = denseIds;
      idToIndex = denseIds ? new DenseObjectIdIndex(i) : sparseIdToIndex!;
    } else {
      const sparseIdToIndex = new Map<ObjectId, number>();
      for (const [id, record] of layout.singles) {
        if (!this.#keepFlatWebglId(id, record.value, timeActive)) continue;
        sparseIdToIndex.set(id, i);
        meta[i] = { kind: "object", id };
        const lat = record.position.lat;
        const lng = record.position.lng;
        const o = i * 2;
        latlng[o] = lat;
        latlng[o + 1] = lng;
        const sin = Math.sin((clampLat(lat) * Math.PI) / 180);
        merc64[o] = (wrapLng(lng) + 180) / 360;
        merc64[o + 1] = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
        i++;
      }
      idToIndex = sparseIdToIndex;
    }
    const packFillMs = perfNow() - packFillStarted;

    this._webglMeta = i === count ? meta : meta.slice(0, i);
    this._webglIdToIndex = idToIndex;
    this._webglSyncedZoom = zoomBucket;
    this._webglSyncedEpoch = this._webglDataEpoch;
    this._webglViewKey = viewKey;
    this._styleZoom = zoomBucket;
    const packMs = perfNow() - packStarted;

    if (i === 0) {
      if (this._webglLayer) {
        this._webglLayer.off();
        this._webglLayer.remove();
        this._webglLayer = null;
      }
      this._gpuSubset = false;
      this._webglPack = null;
      this._webglSyncProfile = {
        points: 0,
        totalMs: perfNow() - syncStarted,
        packMs,
        packAllocateMs,
        packFillMs,
        styleMs: 0,
        layerMs: 0,
        canonicalMs: 0,
        styled: this.#usesStyledWebgl(),
        zeroCopyCanonical: false,
        denseIdIndex
      };
      return;
    }

    const styleStarted = perfNow();
    const { colors, sizes } =
      fullFlatMassPack && i === count
        ? this.#buildWebglStylesFromSingles(layout.singles, i)
        : this.#buildWebglStyles(this._webglMeta);
    const styleMs = perfNow() - styleStarted;

    const interactive = i <= 40_000;
    const maxDpr = i >= 250_000 ? 1 : 1.5;
    const layerStarted = perfNow();
    if (!this._webglLayer) {
      this._webglLayer = webglPointLayer([], {
        pointSize: DEFAULT_OBJECT_SIZE,
        color: DEFAULT_OBJECT_COLOR,
        opacity: DEFAULT_OBJECT_OPACITY,
        maxDpr,
        interactive,
        hitTolerance: 10
      });
      this._webglLayer.on("click", (event) => this.#webglClick(event));
      this._webglLayer.on("hover", (event) => this.#webglHover(event));
      this._webglLayer.addTo(this.map as Orihon);
    } else {
      this._webglLayer.options.maxDpr = maxDpr;
      this._webglLayer.setInteractive(interactive);
    }
    const packedLat = i === count ? latlng : latlng.subarray(0, i * 2);
    const packedMerc = i === count ? merc64 : merc64.subarray(0, i * 2);
    this._webglLayer.setPackedData(packedLat, packedMerc, { colors, sizes, adopt: i === count });
    const layerMs = perfNow() - layerStarted;

    const canonicalStarted = perfNow();
    let zeroCopyCanonical = false;
    if (!this.options.clusterize && !this.filter && !timeActive) {
      if (i === count) {
        // `setPackedData(..., adopt:true)` already made these the layer's canonical
        // arrays. Keep the same references instead of copying 20+ MB of styles,
        // cloning a 1M-entry Map and duplicating the metadata array.
        this._webglPack = {
          latlng,
          merc64,
          colors,
          sizes,
          meta: this._webglMeta,
          idToIndex,
          singles: layout.singles
        };
        zeroCopyCanonical = true;
      } else {
        // Rare sceneFeatures/non-point path: retain the conservative compact copy.
        this._webglPack = {
          latlng: packedLat instanceof Float32Array ? packedLat : new Float32Array(packedLat),
          merc64: packedMerc instanceof Float64Array ? packedMerc : new Float64Array(packedMerc),
          colors: colors ? colors.slice() : null,
          sizes: sizes ? sizes.slice() : null,
          meta: this._webglMeta.slice(),
          idToIndex: cloneWebglIdIndex(idToIndex),
          singles: layout.singles
        };
      }
    }
    const canonicalMs = perfNow() - canonicalStarted;

    this._webglSyncProfile = {
      points: i,
      totalMs: perfNow() - syncStarted,
      packMs,
      packAllocateMs,
      packFillMs,
      styleMs,
      layerMs,
      canonicalMs,
      styled: this.#usesStyledWebgl(),
      zeroCopyCanonical,
      denseIdIndex
    };
  }

  #buildFlatLayout(zoomBucket: number): void {
    // No filter: reuse spatial index Map (avoid copying 1M entries).
    if (!this.filter) {
      this._layout = {
        zoomBucket,
        singles: this.index.records as Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>,
        clusters: new Map()
      };
    } else {
      const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
      for (const record of this.index.records.values()) {
        if (!this.filter(record.value, record.id)) continue;
        singles.set(record.id, record);
      }
      this._layout = { zoomBucket, singles, clusters: new Map() };
    }
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
      const activeTimeIds = this.scene.activeTimeIds();
      if (!this.filter && !activeTimeIds) {
        this.#applyWebglPack(this._webglPack, zoomBucket, false);
        return;
      }

      const pack = this._webglPack;
      const sourceCount = pack.meta.length;
      const filter = this.filter;
      let w = 0;

      // If every managed object is a canonical packed point and the temporal index
      // returns the same cardinality, its active set necessarily covers the full pack.
      // Skip the 1M id→slot lookups + bitset build in that common full-range case.
      const temporalCoversFullPack = Boolean(
        activeTimeIds &&
          activeTimeIds.size === sourceCount &&
          sourceCount === this.items.size &&
          pack.idToIndex.size === sourceCount
      );

      if (activeTimeIds && !temporalCoversFullPack) {
        // Time filtering is already indexed by ObjectSceneController. Convert the active
        // ids to packed GPU slots once, then scan 32 slots per JS iteration. This avoids
        // `Set.has()` + object lookup for every source point and, when a custom filter is
        // also active, invokes that callback only for temporally eligible candidates.
        const wordCount = Math.ceil(sourceCount / 32);
        if (this._webglSystemMask.length < wordCount) {
          this._webglSystemMask = new Uint32Array(wordCount);
        } else {
          this._webglSystemMask.fill(0, 0, wordCount);
        }

        const mask = this._webglSystemMask;
        let marked = 0;
        for (const id of activeTimeIds) {
          const slot = pack.idToIndex.get(id);
          if (slot == null) continue;
          const wordIndex = slot >>> 5;
          const bit = 1 << (slot & 31);
          if ((mask[wordIndex] & bit) !== 0) continue;
          mask[wordIndex] |= bit;
          marked += 1;
        }

        if (marked > 0) {
          this.#ensureWebglFilterIndexCapacity(marked);
          const items = this.items;
          for (let wordIndex = 0; wordIndex < wordCount; wordIndex++) {
            let bits = mask[wordIndex] >>> 0;
            while (bits !== 0) {
              const bitIndex = 31 - Math.clz32(bits & -bits);
              const slot = (wordIndex << 5) + bitIndex;
              if (!filter) {
                this._webglFilterIndexScratch[w++] = slot;
              } else {
                const entry = pack.meta[slot];
                const id = entry.id;
                const object = items.get(id);
                if (object && filter(object, id)) {
                  this._webglFilterIndexScratch[w++] = slot;
                }
              }
              bits = (bits & (bits - 1)) >>> 0;
            }
          }
        }
      } else if (filter) {
        // Full temporal coverage is equivalent to no temporal restriction. Arbitrary
        // callbacks still require O(N), but avoid building/enumerating the system bitset.
        this.#ensureWebglFilterIndexCapacity(sourceCount);
        const items = this.items;
        for (let i = 0; i < sourceCount; i++) {
          const entry = pack.meta[i];
          const id = entry.id;
          const object = items.get(id);
          if (object && filter(object, id)) {
            this._webglFilterIndexScratch[w++] = i;
          }
        }
      } else {
        w = sourceCount;
      }

      // A predicate that keeps every object should cost only the scan. Reusing the
      // canonical pack avoids rebuilding 1M Maps and typed arrays for an identical view.
      if (w === sourceCount) {
        if (this._webglMeta === pack.meta && this._webglIdToIndex === pack.idToIndex) {
          this._layout = { zoomBucket, singles: pack.singles, clusters: new Map() };
          this._layoutDirty = false;
          this._visibleObjects = sourceCount;
          this._webglSyncedZoom = zoomBucket;
          this._webglSyncedEpoch = this._webglDataEpoch;
          this._webglViewKey = this.#flatViewKey();
          this._styleZoom = zoomBucket;
          this._activeRenderer = "webgl";
          this.emit("render", { stats: this.getStats() });
        } else {
          this.#applyWebglPack(pack, zoomBucket, false);
        }
        return;
      }

      const meta = new Array<WebGLMeta>(w);
      const idToIndex = new Map<ObjectId, number>();
      const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
      const latlng = new Float32Array(w * 2);
      const merc64 = new Float64Array(w * 2);
      const colors = pack.colors ? new Float32Array(w * 4) : null;
      const sizes = pack.sizes ? new Float32Array(w) : null;

      // Copy packed numeric data by contiguous source runs. TypedArray#set moves
      // long accepted ranges in native code instead of scalar JS assignments.
      let dstRun = 0;
      let runStart = -1;
      let runEnd = -1;
      const flushRun = (): void => {
        if (runStart < 0) return;
        const runLength = runEnd - runStart + 1;
        latlng.set(pack.latlng.subarray(runStart * 2, (runEnd + 1) * 2), dstRun * 2);
        merc64.set(pack.merc64.subarray(runStart * 2, (runEnd + 1) * 2), dstRun * 2);
        if (colors && pack.colors) {
          colors.set(pack.colors.subarray(runStart * 4, (runEnd + 1) * 4), dstRun * 4);
        }
        if (sizes && pack.sizes) {
          sizes.set(pack.sizes.subarray(runStart, runEnd + 1), dstRun);
        }
        dstRun += runLength;
      };

      for (let dstIndex = 0; dstIndex < w; dstIndex++) {
        const srcIndex = this._webglFilterIndexScratch[dstIndex];
        if (runStart < 0) {
          runStart = srcIndex;
          runEnd = srcIndex;
        } else if (srcIndex === runEnd + 1) {
          runEnd = srcIndex;
        } else {
          flushRun();
          runStart = srcIndex;
          runEnd = srcIndex;
        }

        const entry = pack.meta[srcIndex];
        const record = pack.singles.get(entry.id) || this.index.records.get(entry.id);
        if (!record) continue;
        idToIndex.set(entry.id, dstIndex);
        meta[dstIndex] = entry;
        singles.set(entry.id, record);
      }
      flushRun();

      // P0.5 keeps full-pack styles synchronized even for objects currently hidden
      // by a filter. Rebuild only if a styled pack is unexpectedly missing arrays.
      let liveColors: Float32Array | null = colors;
      let liveSizes: Float32Array | null = sizes;
      if (this.#usesStyledWebgl() && (!liveColors || (this._styleResolver && !liveSizes))) {
        const live = this.#buildWebglStyles(meta);
        liveColors = live.colors;
        liveSizes = live.sizes;
      }
      this._webglLayer.setPackedData(latlng, merc64, {
        colors: liveColors,
        sizes: liveSizes,
        adopt: true
      });
      this._layout = { zoomBucket, singles, clusters: new Map() };
      this._layoutDirty = false;
      this._webglMeta = meta;
      this._webglIdToIndex = idToIndex;
      this._visibleObjects = w;
      this._webglSyncedZoom = zoomBucket;
      this._webglSyncedEpoch = this._webglDataEpoch;
      this._webglViewKey = this.#flatViewKey();
      this._styleZoom = zoomBucket;
      this._activeRenderer = "webgl";
      this._webglLayer.setInteractive(w <= 40_000);
      this.emit("render", { stats: this.getStats() });
      return;
    }

    const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
    const points: LatLngLike[] = [];
    const meta: WebGLMeta[] = [];
    const idToIndex = new Map<ObjectId, number>();
    const activeTimeIds = this.scene.activeTimeIds();

    for (const record of this.index.records.values()) {
      if (!this.#keepFlatWebglId(record.id, record.value, activeTimeIds)) continue;
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

    const { colors, sizes } = this.#buildWebglStyles(meta);
    const interactive = points.length <= 40_000;
    const maxDpr = points.length >= 250_000 ? 1 : 1.5;
    if (!this._webglLayer) {
      this._webglLayer = webglPointLayer([], {
        pointSize: DEFAULT_OBJECT_SIZE,
        color: DEFAULT_OBJECT_COLOR,
        opacity: DEFAULT_OBJECT_OPACITY,
        maxDpr,
        interactive,
        hitTolerance: 10
      });
      this._webglLayer.on("click", (event) => this.#webglClick(event));
      this._webglLayer.on("hover", (event) => this.#webglHover(event));
      this._webglLayer.addTo(this.map as Orihon);
    } else {
      this._webglLayer.options.maxDpr = maxDpr;
      this._webglLayer.setInteractive(interactive);
    }
    this._webglLayer.setData(points, { colors, sizes });
    this._webglSyncedZoom = zoomBucket;
    this._webglSyncedEpoch = this._webglDataEpoch;
    this._webglViewKey = this.#flatViewKey();
    this._styleZoom = zoomBucket;

    // Snapshot the unfiltered pack once so later filters are O(visible) copies.
    if (!this.filter && !this.scene.activeTimeIds()) {
      this.#snapshotWebglPack(singles, meta, idToIndex, colors, sizes);
    }

    this.emit("render", { stats: this.getStats() });
  }

  #ensureWebglFilterIndexCapacity(count: number): void {
    if (this._webglFilterIndexScratch.length >= count) return;
    const next = Math.max(count, 1024, Math.ceil(this._webglFilterIndexScratch.length * 1.5));
    this._webglFilterIndexScratch = new Uint32Array(next);
  }

  #applyWebglIdSubset(ids: Iterable<ObjectId>): void {
    if (!this.map || !this._webglLayer) return;
    const pack = this._webglPack;
    const zoomBucket = Math.floor(this.map.zoom);
    const list = Array.isArray(ids) ? ids : [...ids];
    if (!pack) {
      const allow = new Set(list);
      const prev = this.filter;
      this.filter = (_object, id) => allow.has(id);
      this.#fastWebglFilterSync();
      this.filter = prev;
      return;
    }
    const n = list.length;
    const latlng = new Float32Array(n * 2);
    const merc64 = new Float64Array(n * 2);
    const colors = pack.colors ? new Float32Array(n * 4) : null;
    const sizes = pack.sizes ? new Float32Array(n) : null;
    const meta: WebGLMeta[] = [];
    const idToIndex = new Map<ObjectId, number>();
    const singles = new Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>();
    let w = 0;
    for (const id of list) {
      const i = pack.idToIndex.get(id);
      if (i == null) continue;
      const record = pack.singles.get(id) || this.index.records.get(id);
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
      if (sizes && pack.sizes) sizes[w] = pack.sizes[i];
      idToIndex.set(id, w);
      meta.push(pack.meta[i]);
      singles.set(id, record);
      w += 1;
    }
    let liveColors: Float32Array | null = colors ? colors.subarray(0, w * 4) : null;
    let liveSizes: Float32Array | null = sizes ? sizes.subarray(0, w) : null;
    if (this.#usesStyledWebgl() && (!liveColors || (this._styleResolver && !liveSizes))) {
      const live = this.#buildWebglStyles(meta);
      liveColors = live.colors;
      liveSizes = live.sizes;
    }
    this._webglLayer.setPackedData(
      w === n ? latlng : latlng.subarray(0, w * 2),
      w === n ? merc64 : merc64.subarray(0, w * 2),
      { colors: liveColors, sizes: liveSizes, adopt: true }
    );
    this._layout = { zoomBucket, singles, clusters: new Map() };
    this._layoutDirty = false;
    this._webglMeta = meta;
    this._webglIdToIndex = idToIndex;
    this._visibleObjects = w;
    this._webglSyncedZoom = zoomBucket;
    this._webglSyncedEpoch = this._webglDataEpoch;
    this._webglViewKey = this.#flatViewKey();
    this._styleZoom = zoomBucket;
    this._activeRenderer = "webgl";
    this._webglLayer.setHidden(false);
    this._webglLayer.setInteractive(w <= 40_000);
    this.emit("render", { stats: this.getStats() });
  }

  #applyWebglPack(
    pack: NonNullable<ObjectManager["_webglPack"]>,
    zoomBucket: number,
    rebuildColors: boolean
  ): void {
    if (!this._webglLayer) return;
    const styles =
      rebuildColors && this.#usesStyledWebgl()
        ? this.#buildWebglStyles(pack.meta)
        : { colors: pack.colors, sizes: pack.sizes };
    this._webglLayer.setPackedData(pack.latlng, pack.merc64, {
      colors: styles.colors,
      sizes: styles.sizes,
      // Canonical ObjectManager pack: WebGLPointLayer may reference these buffers
      // directly; all point mutations are mirrored back into the same pack.
      adopt: true
    });
    this._layout = { zoomBucket, singles: pack.singles, clusters: new Map() };
    this._layoutDirty = false;
    this._webglMeta = pack.meta;
    this._webglIdToIndex = pack.idToIndex;
    this._visibleObjects = pack.meta.length;
    this._webglSyncedZoom = zoomBucket;
    this._webglSyncedEpoch = this._webglDataEpoch;
    this._webglViewKey = this.#flatViewKey();
    this._styleZoom = zoomBucket;
    this._activeRenderer = "webgl";
    this._webglLayer.setInteractive(pack.meta.length <= 40_000);
    this.emit("render", { stats: this.getStats() });
  }

  #snapshotWebglPack(
    singles: Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>,
    meta: WebGLMeta[],
    idToIndex: Map<ObjectId, number>,
    colors: Float32Array | null,
    sizes: Float32Array | null
  ): void {
    if (!this._webglLayer) return;
    const latlng = this._webglLayer.getLatLngBuf().slice();
    const merc64 = this._webglLayer.getMercator64().slice();
    this._webglPack = {
      latlng,
      merc64,
      colors: colors ? colors.slice() : null,
      sizes: sizes ? sizes.slice() : null,
      meta: meta.slice(),
      idToIndex: new Map(idToIndex),
      singles
    };
  }

  #usesStyledWebgl(): boolean {
    return Boolean(this._styleResolver) || this.options.styleByCategory;
  }

  #webglTopologyMatches(layout: LayoutCache): boolean {
    if (this._webglIdToIndex.size === 0) return false;
    // Flat mass path: membership is gated by data epoch + view key (time/filter).
    if (!this.options.clusterize) return true;
    if (this._webglIdToIndex.size !== layout.singles.size) return false;
    for (const id of layout.singles.keys()) {
      if (!this._webglIdToIndex.has(id)) return false;
    }
    return true;
  }

  #buildWebglStyles(meta: WebGLMeta[]): { colors: Float32Array | null; sizes: Float32Array | null } {
    if (!this.#usesStyledWebgl()) return { colors: null, sizes: null };
    const colors = new Float32Array(meta.length * 4);
    const sizes = this._styleResolver ? new Float32Array(meta.length) : null;
    const zoom = this.map?.zoom ?? 0;
    const visualization = this.scene.getActiveVisualization();
    for (let i = 0; i < meta.length; i++) {
      const entry = meta[i];
      if (entry.kind !== "object") {
        const o = i * 4;
        colors[o] = OBJECT_MANAGER_PALETTE.alpha[0];
        colors[o + 1] = OBJECT_MANAGER_PALETTE.alpha[1];
        colors[o + 2] = OBJECT_MANAGER_PALETTE.alpha[2];
        colors[o + 3] = OBJECT_MANAGER_PALETTE.alpha[3];
        if (sizes) sizes[i] = DEFAULT_OBJECT_SIZE;
        continue;
      }
      const object = this.items.get(entry.id);
      if (!object) continue;
      this.#writeWebglPointStyle(entry.id, object, colors, sizes, i, zoom, visualization);
    }
    return { colors, sizes };
  }

  #buildWebglStylesFromSingles(
    singles: Map<ObjectId, SpatialRecord<ManagedObject, ObjectId>>,
    count: number
  ): { colors: Float32Array | null; sizes: Float32Array | null } {
    if (!this.#usesStyledWebgl()) return { colors: null, sizes: null };
    const colors = new Float32Array(count * 4);
    const sizes = this._styleResolver ? new Float32Array(count) : null;
    const zoom = this.map?.zoom ?? 0;
    const visualization = this.scene.getActiveVisualization();
    let i = 0;
    for (const [id, record] of singles) {
      if (i >= count) break;
      this.#writeWebglPointStyle(id, record.value, colors, sizes, i, zoom, visualization);
      i += 1;
    }
    return { colors, sizes };
  }

  #writeWebglPointStyle(
    id: ObjectId,
    object: ManagedObject,
    colors: Float32Array,
    sizes: Float32Array | null,
    index: number,
    zoom: number,
    visualization: ObjectStyleContext["visualization"]
  ): void {
    const state = this.objectStates.size > 0 ? (this.objectStates.get(id) ?? EMPTY_OBJECT_STATE) : EMPTY_OBJECT_STATE;
    const selected = this._selectedId === id;
    const hovered = this._hoveredId === id;

    let color = DEFAULT_OBJECT_COLOR;
    let opacity = DEFAULT_OBJECT_OPACITY;
    let size = DEFAULT_OBJECT_SIZE;

    if (this.options.styleByCategory) {
      if (selected || state.selected) {
        color = PALETTE_HEX.selected;
        opacity = OBJECT_MANAGER_PALETTE.selected[3];
      } else if (hovered || state.hovered) {
        color = PALETTE_HEX.hover;
        opacity = OBJECT_MANAGER_PALETTE.hover[3];
      } else if (object.properties?.alert) {
        color = PALETTE_HEX.alert;
        opacity = OBJECT_MANAGER_PALETTE.alert[3];
      } else {
        const category = String(object.properties?.category || "alpha");
        if (category === "beta") {
          color = PALETTE_HEX.beta;
          opacity = OBJECT_MANAGER_PALETTE.beta[3];
        } else if (category === "gamma") {
          color = PALETTE_HEX.gamma;
          opacity = OBJECT_MANAGER_PALETTE.gamma[3];
        } else {
          color = PALETTE_HEX.alpha;
          opacity = OBJECT_MANAGER_PALETTE.alpha[3];
        }
      }
    }

    if (this._styleResolver) {
      const context: ObjectStyleContext = {
        id,
        zoom,
        renderer: "webgl",
        selected,
        hovered,
        visualization
      };
      const custom = this._styleResolver(object, state, context);
      if (custom) {
        const customFill = custom.fill ?? custom.color;
        const customFillOpacity = custom.fillOpacity ?? custom.opacity;
        if (customFill !== undefined) color = customFill;
        if (customFillOpacity !== undefined) opacity = customFillOpacity;
        if (custom.size !== undefined) size = custom.size;
      }
    }

    const normalizedColor = typeof color === "string" && color.trim() ? color : DEFAULT_OBJECT_COLOR;
    const rgb = this.#webglRgb(normalizedColor);
    let normalizedOpacity = Number(opacity);
    if (!Number.isFinite(normalizedOpacity)) normalizedOpacity = DEFAULT_OBJECT_OPACITY;
    normalizedOpacity = Math.max(0, Math.min(1, normalizedOpacity));
    let normalizedSize = Number(size);
    if (!Number.isFinite(normalizedSize)) normalizedSize = DEFAULT_OBJECT_SIZE;
    normalizedSize = Math.max(1, Math.min(MAX_OBJECT_SIZE, normalizedSize));

    const o = index * 4;
    colors[o] = rgb[0];
    colors[o + 1] = rgb[1];
    colors[o + 2] = rgb[2];
    colors[o + 3] = normalizedOpacity;
    if (sizes) sizes[index] = normalizedSize;
  }

  #webglRgb(color: string): readonly [number, number, number] {
    const cached = this._webglColorCache.get(color);
    if (cached) return cached;
    const rgb = parseCssColor(color, { r: DEFAULT_OBJECT_RGB.r, g: DEFAULT_OBJECT_RGB.g, b: DEFAULT_OBJECT_RGB.b });
    const normalized = [rgb.r / 255, rgb.g / 255, rgb.b / 255] as const;
    // A bounded cache captures the common constant/palette case without retaining
    // arbitrarily many data-driven colors from user style callbacks.
    if (this._webglColorCache.size < 64) this._webglColorCache.set(color, normalized);
    return normalized;
  }

  #legacyRgba(object: ManagedObject | undefined, id: ObjectId | null): readonly [number, number, number, number] {
    if (id != null && this._selectedId != null && id === this._selectedId) return OBJECT_MANAGER_PALETTE.selected;
    if (id != null && this._hoveredId != null && id === this._hoveredId) return OBJECT_MANAGER_PALETTE.hover;
    if (object?.properties?.alert) return OBJECT_MANAGER_PALETTE.alert;
    const category = String(object?.properties?.category || "alpha");
    if (category === "beta") return OBJECT_MANAGER_PALETTE.beta;
    if (category === "gamma") return OBJECT_MANAGER_PALETTE.gamma;
    return OBJECT_MANAGER_PALETTE.alpha;
  }

  #refreshWebglStyles(): void {
    if (!this._webglLayer || !this._webglMeta.length || !this.#usesStyledWebgl()) return;
    const { colors, sizes } = this.#buildWebglStyles(this._webglMeta);
    this._webglLayer.setColors(colors);
    if (sizes) this._webglLayer.setSizes(sizes);
    else this._webglLayer.setSizes(null);

    const pack = this._webglPack;
    if (!pack || !colors) return;
    const fullPackView =
      (this._webglMeta === pack.meta && this._webglIdToIndex === pack.idToIndex) ||
      (!this.filter && !this._gpuSubset && !this.scene.activeTimeIds() && this._webglMeta.length === pack.meta.length);
    if (fullPackView) {
      pack.colors = colors.slice();
      pack.sizes = sizes ? sizes.slice() : null;
      return;
    }

    // If styling was enabled after the full pack was created, build canonical
    // arrays once. Never leave hidden slots zero/stale in a partially styled pack.
    if (!pack.colors || (sizes && !pack.sizes)) {
      const full = this.#buildWebglStyles(pack.meta);
      pack.colors = full.colors ? full.colors.slice() : null;
      pack.sizes = full.sizes ? full.sizes.slice() : null;
      return;
    }

    // Current GPU view is filtered/subset: patch matching slots in the canonical
    // full pack instead of replacing it with shorter, differently aligned arrays.
    for (let i = 0; i < this._webglMeta.length; i++) {
      const entry = this._webglMeta[i];
      if (entry.kind !== "object") continue;
      const packSlot = pack.idToIndex.get(entry.id);
      if (packSlot == null) continue;
      const src = i * 4;
      const dst = packSlot * 4;
      pack.colors[dst] = colors[src];
      pack.colors[dst + 1] = colors[src + 1];
      pack.colors[dst + 2] = colors[src + 2];
      pack.colors[dst + 3] = colors[src + 3];
      if (sizes && pack.sizes) pack.sizes[packSlot] = sizes[i];
    }
  }

  #patchWebglStyles(ids: ObjectId[]): void {
    if (!this._webglLayer || !this.#usesStyledWebgl() || ids.length === 0) return;
    const useCustom = Boolean(this._styleResolver);
    this.#ensureWebglStylePatchCapacity(ids.length);
    const pack = this._webglPack;
    let write = 0;

    for (const id of ids) {
      const object = this.items.get(id);
      if (!object) continue;

      let rgba: readonly [number, number, number, number];
      let resolvedSize = 0;
      if (useCustom) {
        const resolved = this.#resolveObjectStyle(id, object, "webgl");
        rgba = resolved.rgba;
        resolvedSize = resolved.size;
      } else {
        rgba = this.#legacyRgba(object, id);
      }

      // Keep the canonical full pack current even when the object is currently
      // filtered out. Future compaction can reuse styles without N callbacks.
      const packSlot = pack?.idToIndex.get(id);
      if (pack?.colors && packSlot != null) {
        const o = packSlot * 4;
        pack.colors[o] = rgba[0];
        pack.colors[o + 1] = rgba[1];
        pack.colors[o + 2] = rgba[2];
        pack.colors[o + 3] = rgba[3];
      }
      if (useCustom && pack?.sizes && packSlot != null) pack.sizes[packSlot] = resolvedSize;

      const slot = this._webglIdToIndex.get(id);
      if (slot == null) continue;
      this._webglStylePatchIndices[write] = slot;
      const patchOffset = write * 4;
      this._webglStylePatchColors[patchOffset] = rgba[0];
      this._webglStylePatchColors[patchOffset + 1] = rgba[1];
      this._webglStylePatchColors[patchOffset + 2] = rgba[2];
      this._webglStylePatchColors[patchOffset + 3] = rgba[3];
      if (useCustom) this._webglStylePatchSizes[write] = resolvedSize;
      write += 1;
    }

    if (write > 0) {
      this._webglLayer.patchStyles(
        this._webglStylePatchIndices,
        this._webglStylePatchColors,
        useCustom ? this._webglStylePatchSizes : null,
        write
      );
    }
  }

  #ensureWebglStylePatchCapacity(count: number): void {
    if (this._webglStylePatchIndices.length >= count) return;
    const next = Math.max(count, 64, Math.ceil(this._webglStylePatchIndices.length * 1.5));
    this._webglStylePatchIndices = new Uint32Array(next);
    this._webglStylePatchColors = new Float32Array(next * 4);
    this._webglStylePatchSizes = new Float32Array(next);
  }

  #resolveObjectStyle(
    id: ObjectId,
    object: ManagedObject,
    renderer: "dom" | "webgl"
  ): ResolvedObjectStyle {
    const state = this.objectStates.get(id) ?? EMPTY_OBJECT_STATE;
    const selected = this._selectedId === id;
    const hovered = this._hoveredId === id;
    const context: ObjectStyleContext = {
      id,
      zoom: this.map?.zoom ?? 0,
      renderer,
      selected,
      hovered,
      visualization: this.scene.getActiveVisualization()
    };

    const legacy = legacyObjectStyle(object, state, context, this.options.styleByCategory);
    let merged: ObjectStyle = {
      color: legacy.color ?? DEFAULT_OBJECT_COLOR,
      opacity: legacy.opacity ?? DEFAULT_OBJECT_OPACITY,
      size: legacy.size ?? DEFAULT_OBJECT_SIZE,
      icon: null,
      rotation: 0,
      visible: true,
      label: null,
      collisionMode: selected || hovered ? "always" : "auto",
      trail: null,
      line: undefined,
      polygon: undefined
    };

    if (this._styleResolver) {
      const custom = this._styleResolver(object, state, context);
      if (custom) {
        if (custom.fill !== undefined) merged.fill = custom.fill;
        else if (custom.color !== undefined) merged.color = custom.color;
        if (custom.fillOpacity !== undefined) merged.fillOpacity = custom.fillOpacity;
        else if (custom.opacity !== undefined) merged.opacity = custom.opacity;
        if (custom.size !== undefined) merged.size = custom.size;
        if (custom.icon !== undefined) merged.icon = custom.icon;
        if (custom.iconTint !== undefined) merged.iconTint = custom.iconTint;
        if (custom.rotation !== undefined) merged.rotation = custom.rotation;
        if (custom.visible !== undefined) merged.visible = custom.visible;
        if (custom.label !== undefined) merged.label = custom.label;
        if (custom.collisionMode !== undefined) merged.collisionMode = custom.collisionMode;
        if (custom.trail !== undefined) merged.trail = custom.trail;
        if (custom.line !== undefined) merged.line = custom.line;
        if (custom.polygon !== undefined) merged.polygon = custom.polygon;
      }
    }

    return normalizeResolvedStyle(merged);
  }

  #storedPoint(id: ObjectId): { lat: number; lng: number } | null {
    const geom = this.scene.geometries.get(id);
    if (geom?.kind === "Point") return { lat: geom.lat, lng: geom.lng };
    const record = this.index.records.get(id);
    return record ? { lat: record.position.lat, lng: record.position.lng } : null;
  }

  #flatViewKey(): string {
    const range = this.scene.timeIndex?.range;
    const from = range?.from ?? "";
    const to = range?.to ?? "";
    return `${from}:${to}:${this.filter ? 1 : 0}`;
  }

  #keepFlatWebglId(
    id: ObjectId,
    object: ManagedObject | undefined,
    timeActive: Set<ObjectId> | null
  ): boolean {
    if (!object) return false;
    if (this.filter && !this.filter(object, id)) return false;
    if (timeActive && !timeActive.has(id)) return false;
    if (this.options.sceneFeatures) {
      const geometry = this.scene.geometries.get(id);
      if (geometry && geometry.kind !== "Point") return false;
    }
    return true;
  }

  #ingestObject(
    id: ObjectId,
    item: ManagedObject,
    options: { skipSearch?: boolean } = {}
  ): NormalizedGeometry | null {
    const normalized = tryNormalizeManagedGeometry(item, {
      maxVertices: this.options.maxVerticesPerGeometry
    });
    if (!normalized) {
      this.scene.removeGeometry(id);
      return null;
    }
    // Mass-point mode: keep coords in the spatial index only — scene Maps double heap at 1M.
    if (this.options.sceneFeatures) {
      this.scene.setGeometry(id, normalized);
    }
    if (!options.skipSearch) {
      this.scene.searchIndex?.upsert(id, item);
      this.scene.timeIndex?.upsert(id, item);
    }
    return normalized;
  }

  #filterClusterSpecsByTime(
    specs: Map<string, ClusterSpec>,
    timeActive: Set<ObjectId> | null
  ): void {
    if (!timeActive) return;
    for (const [key, spec] of specs) {
      const ids = spec.ids.length ? spec.ids.filter((id) => timeActive.has(id)) : spec.ids;
      if (!ids.length && spec.count) {
        // lazy clusters without expanded ids — keep unless we can prove empty
        continue;
      }
      if (spec.ids.length && !ids.length) {
        specs.delete(key);
        continue;
      }
      if (ids.length) {
        spec.ids = ids;
        spec.count = ids.length;
      }
    }
  }

  #syncHeatmap(): void {
    if (!this.map) return;
    const pack = this._webglPack;
    if (pack && !this.filter && !this.scene.activeTimeIds()) {
      this.scene.syncHeatPacked(pack.merc64, pack.meta.length, this.map as Orihon, this.#heatWeightsForPack(pack));
      return;
    }
    const timeActive = this.scene.activeTimeIds();
    const points: Array<[number, number, number?]> = [];
    if (this.options.sceneFeatures) {
      for (const [id, object] of this.items) {
        if (timeActive && !timeActive.has(id)) continue;
        if (this.filter && !this.filter(object, id)) continue;
        const geometry = this.scene.geometries.get(id);
        if (!geometry || geometry.kind !== "Point") continue;
        const weight = this.scene.heatmapWeight?.(object, id) ?? 1;
        points.push([geometry.lat, geometry.lng, weight]);
      }
    } else {
      for (const record of this.index.records.values()) {
        const id = record.id;
        if (timeActive && !timeActive.has(id)) continue;
        if (this.filter && !this.filter(record.value, id)) continue;
        const weight = this.scene.heatmapWeight?.(record.value, id) ?? 1;
        points.push([record.position.lat, record.position.lng, weight]);
      }
    }
    this.scene.syncHeat(points, this.map as Orihon);
  }

  #heatWeightsForPack(
    pack: NonNullable<ObjectManager["_webglPack"]>
  ): Float32Array | null {
    const fn = this.scene.heatmapWeight;
    if (!fn) return null;
    const n = pack.meta.length;
    if (this._heatWeightBuf.length < n) this._heatWeightBuf = new Float32Array(Math.max(n, 8));
    const out = this._heatWeightBuf;
    for (let i = 0; i < n; i++) {
      const id = pack.meta[i].id;
      const object = pack.singles.get(id)?.value ?? this.items.get(id);
      const raw = object ? Number(fn(object, id)) : 0;
      out[i] = Number.isFinite(raw) && raw > 0 ? raw : 0;
    }
    return out.subarray(0, n);
  }

  #redrawLabelsDuringMove(): void {
    if (!this.map || typeof document === "undefined") return;
    if (!this.options.sceneFeatures) return;
    this.scene.redrawLabels(this.map as Orihon, { declutter: false });
  }

  /**
   * True when icons / lines / polygons / labels / non-object viz may need the O(n) scene walk.
   * Plain mass points with only category colors skip it even if `sceneFeatures` stayed true.
   */
  #sceneDecorationsActive(): boolean {
    if (this.options.declutter) return true;
    if (this.scene.atlas.size > 0) return true;
    if (this._styleResolver || this.options.style) return true;
    if (this.scene.visualization !== "objects") return true;
    if (this.scene.hasNonPointGeometries()) return true;
    return false;
  }

  #syncSceneLayers(): void {
    if (!this.map) return;
    // Mass WebGL points: never walk 1M objects resolving styles for icons/labels/trails.
    if (!this.options.sceneFeatures || !this.#sceneDecorationsActive()) {
      this.scene.clearNonHeatLayers();
      return;
    }
    const timeActive = this.scene.activeTimeIds();
    const symbolInstances = [];
    const paths = [];
    const polygons = [];
    const labelCandidates: LabelCandidate[] = [];
    const labelAnchors = [];
    const area = bounds(this.map.getBounds()).pad(0.2);
    const viewportBBox = [area.south, area.west, area.north, area.east] as const;

    for (const [id, object] of this.items) {
      if (timeActive && !timeActive.has(id)) continue;
      if (this.filter && !this.filter(object, id)) continue;
      const geometry = this.scene.geometries.get(id);
      if (!geometry) continue;
      const resolved = this.#resolveObjectStyle(id, object, this._activeRenderer);
      if (!resolved.visible) continue;
      this.scene.trails.configure(id, resolved.trail);

      if (geometry.kind === "Point") {
        const visual = this.scene.visualPosition(id, geometry.lat, geometry.lng);
        if (resolved.icon) {
          const motion = this.scene.motions.get(id);
          // GPU mixes prev→target; pass authoritative target coords, not CPU-interpolated ones.
          symbolInstances.push({
            id,
            lat: geometry.lat,
            lng: geometry.lng,
            icon: resolved.icon,
            size: resolved.size,
            rotation: resolved.rotation,
            opacity: resolved.opacity,
            tint: styleTint({
              color: resolved.color,
              opacity: resolved.opacity,
              iconTint: resolved.iconTint ?? undefined
            }),
            prevLat: motion?.fromLat ?? geometry.lat,
            prevLng: motion?.fromLng ?? geometry.lng,
            startTimeMs: motion?.startTimeMs ?? 0,
            durationMs: motion?.durationMs ?? 0
          });
          if (this.options.declutter && this.map) {
            const project =
              this.map.latLngToContainerPoint?.bind(this.map) ??
              ((value: LatLngLike) => this.map!.latLngToLayerPoint(value));
            const screen = project({ lat: visual.lat, lng: visual.lng });
            labelCandidates.push({
              id,
              text: "",
              x: screen.x - resolved.size / 2,
              y: screen.y - resolved.size / 2,
              width: resolved.size,
              height: resolved.size,
              priority: Number(resolved.label?.priority) || 0,
              collisionMode:
                this._selectedId === id || this._hoveredId === id
                  ? "always"
                  : resolved.collisionMode,
              kind: "icon"
            });
          }
        }
        if (resolved.label && this.map) {
          const zoom = this.map.zoom;
          if (
            (resolved.label.minZoom != null && zoom < resolved.label.minZoom) ||
            (resolved.label.maxZoom != null && zoom > resolved.label.maxZoom)
          ) {
            continue;
          }
          const collisionMode =
            this._selectedId === id || this._hoveredId === id
              ? "always"
              : resolved.collisionMode;
          const anchor = this.scene.buildLabelAnchor(
            id,
            {
              label: resolved.label,
              collisionMode,
              visible: resolved.visible
            },
            visual.lat,
            visual.lng,
            null
          );
          if (anchor) {
            labelAnchors.push(anchor);
            // Keep icon collision boxes in screen space for this sync pass.
            if (this.options.declutter) {
              const project =
                this.map.latLngToContainerPoint?.bind(this.map) ??
                ((value: LatLngLike) => this.map!.latLngToLayerPoint(value));
              const screen = project({ lat: visual.lat, lng: visual.lng });
              labelCandidates.push({
                id,
                text: anchor.text,
                x: screen.x + anchor.offsetX,
                y: screen.y + anchor.offsetY - anchor.height,
                width: anchor.width,
                height: anchor.height,
                priority: anchor.priority,
                collisionMode: anchor.collisionMode,
                kind: "label"
              });
            }
          }
        }
        continue;
      }

      if (geometry.kind === "LineString") {
        if (
          geometry.bbox[2] < viewportBBox[0] ||
          geometry.bbox[0] > viewportBBox[2] ||
          geometry.bbox[3] < viewportBBox[1] ||
          geometry.bbox[1] > viewportBBox[3]
        ) continue;
        const positions: LatLngLike[] = [];
        for (let i = 0; i < geometry.pointCount; i++) {
          positions.push({ lat: geometry.coords[i * 2], lng: geometry.coords[i * 2 + 1] });
        }
        paths.push({
          id,
          positions,
          distances: geometry.distances,
          style: {
            color: resolved.line?.stroke ?? resolved.line?.color ?? resolved.color,
            opacity: resolved.line?.strokeOpacity ?? resolved.line?.opacity ?? resolved.opacity,
            width: resolved.line?.strokeWidth ?? resolved.line?.width ?? 2,
            dashArray: resolved.line?.dashArray,
            dashOffset: resolved.line?.dashOffset,
            gradient: resolved.line?.gradient
          }
        });
        continue;
      }

      if (geometry.kind === "Polygon") {
        if (
          geometry.bbox[2] < viewportBBox[0] ||
          geometry.bbox[0] > viewportBBox[2] ||
          geometry.bbox[3] < viewportBBox[1] ||
          geometry.bbox[1] > viewportBBox[3]
        ) continue;
        polygons.push({
          id,
          rings: geometry.rings,
          style: {
            fill: resolved.polygon?.fill ?? resolved.color,
            fillOpacity: resolved.polygon?.fillOpacity ?? 0.25,
            stroke: resolved.polygon?.stroke ?? resolved.color,
            strokeOpacity: resolved.polygon?.strokeOpacity ?? resolved.opacity,
            strokeWidth: resolved.polygon?.strokeWidth ?? 1.5
          }
        });
      }
    }

    // Trails batch
    for (const trail of this.scene.trails.list()) {
      paths.push({
        positions: trail.points.map((point) => ({ lat: point.lat, lng: point.lng })),
        style: {
          color: trail.style.color,
          width: trail.style.width,
          opacity: trail.style.opacity
        }
      });
    }

    this.scene.syncSymbols(symbolInstances, this.map as Orihon);
    this.scene.syncPaths(paths, this.map as Orihon);
    this.scene.syncPolygons(polygons, this.map as Orihon);
    if (typeof document !== "undefined") {
      this.scene.setLabelAnchors(labelAnchors);
      // Full declutter on authoritative sync; move frames use lightweight redraw.
      this.scene.redrawLabels(this.map as Orihon, { declutter: this.options.declutter });
      void labelCandidates;
    }
  }

  #afterVisualStateChange(ids: ObjectId[]): void {
    const unique = [...new Set(ids)];
    if (this.#canPatchWebgl() && this.#usesStyledWebgl()) {
      this.#patchWebglStyles(unique);
      this._webglLayer!.render();
    } else if (this._webglLayer && this.#usesStyledWebgl()) {
      this.#refreshWebglStyles();
      this._scheduleRender();
    } else {
      this._scheduleRender();
    }
    // heatmapWeight may read ObjectState (alarm) or live readings — keep the field in sync.
    this.#refreshHeatmapIfActive();
    for (const markerId of unique) {
      const marker = this.markers.get(markerId);
      const object = this.items.get(markerId);
      if (marker && object) this.#paintDomMarker(marker, markerId, object);
    }
  }

  #heatVisualizationActive(): boolean {
    if (!this.map) return false;
    return this.scene.resolveVisualization(this.map.zoom) === "heatmap";
  }

  /** Rebuild heat weights when readings/state change while heatmap is the active view. */
  #refreshHeatmapIfActive(): void {
    if (!this.#heatVisualizationActive()) return;
    // Mass value fields re-rasterize hundreds of thousands of stamps — coalesce
    // object-state patches (temp ticks) so we do not rebuild KDE 8×/s.
    if (this._heatRefreshPending) return;
    this._heatRefreshPending = true;
    const delay = this.items.size > 80_000 ? 320 : this.items.size > 20_000 ? 180 : 90;
    this._heatRefreshTimer = setTimeout(() => {
      this._heatRefreshTimer = 0;
      this._heatRefreshPending = false;
      if (!this.#heatVisualizationActive()) return;
      this.#syncHeatmap();
    }, delay) as unknown as number;
  }

  #assertObjectExists(id: ObjectId): void {
    if (!this.items.has(id)) {
      throw new RangeError(`ObjectManager: object "${String(id)}" does not exist`);
    }
  }

  #writeStateFlag(id: ObjectId, key: "selected" | "hovered", value: boolean): void {
    if (!value) {
      const current = this.objectStates.get(id);
      if (!current || !(key in current)) return;
      delete current[key];
      if (!Object.keys(current).length) this.objectStates.delete(id);
      return;
    }
    const current = this.objectStates.get(id);
    if (current) {
      current[key] = true;
      return;
    }
    this.objectStates.set(id, { [key]: true });
  }

  #mergeObjectState(id: ObjectId, patch: Partial<ObjectState>): { changedKeys: string[]; sideTouched: ObjectId[] } {
    const changedKeys: string[] = [];
    const sideTouched: ObjectId[] = [];
    const current = this.objectStates.get(id);
    const next: ObjectState = current ? { ...current } : {};

    for (const [key, rawValue] of Object.entries(patch)) {
      if (rawValue === undefined) {
        if (key in next) {
          delete next[key];
          changedKeys.push(key);
        }
        continue;
      }
      assertObjectStateValue(key, rawValue);
      if (Object.is(next[key], rawValue)) continue;
      next[key] = rawValue;
      changedKeys.push(key);
    }

    if (!changedKeys.length) return { changedKeys, sideTouched };

    if (changedKeys.includes("selected")) {
      if (next.selected === true) {
        if (this._selectedId != null && this._selectedId !== id) {
          this.#writeStateFlag(this._selectedId, "selected", false);
          sideTouched.push(this._selectedId);
        }
        this._selectedId = id;
        next.selected = true;
      } else {
        if (this._selectedId === id) this._selectedId = null;
        delete next.selected;
      }
    }

    if (changedKeys.includes("hovered")) {
      if (next.hovered === true) {
        if (this._hoveredId != null && this._hoveredId !== id) {
          this.#writeStateFlag(this._hoveredId, "hovered", false);
          sideTouched.push(this._hoveredId);
        }
        this._hoveredId = id;
        next.hovered = true;
      } else {
        if (this._hoveredId === id) this._hoveredId = null;
        delete next.hovered;
      }
    }

    if (Object.keys(next).length) this.objectStates.set(id, next);
    else this.objectStates.delete(id);
    return { changedKeys, sideTouched };
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
      const area = bounds();
      for (const id of ids) {
        const object = this.items.get(id);
        const objectPosition = object ? this.#objectPosition(object) : null;
        if (objectPosition) area.extend(objectPosition);
      }
      if (area.isValid()) {
        this.map.fitBounds(area, { padding: 40 });
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
    const context = { source: this, event: event as OrihonEvent | undefined, data };
    if (this._activePopup?.isOpen()) {
      this._activePopup.setLatLng(position);
      this._activePopup.setContentContext(context);
      this._activePopup.setContent(content);
      this._activePopup.bringToFront();
      return;
    }
    this.closePopup();
    const next = new Popup(content, options);
    next.setContentContext(context);
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
    const aggregates = this.scene.aggregateCluster(ids, this.items, this._selectedId);
    const styled = this.options.clusterStyle?.(
      {
        id: ids[0] != null ? `cluster:${String(ids[0])}` : `cluster:${count}`,
        count: aggregates.count || count,
        properties: aggregates.properties,
        containsSelected: aggregates.containsSelected
      },
      {
        id: ids[0] ?? 0,
        zoom: this.map?.zoom ?? 0,
        renderer: this._activeRenderer,
        selected: aggregates.containsSelected,
        hovered: false,
        visualization: this.scene.getActiveVisualization()
      }
    );
    const tier = count < 10 ? "sm" : count < 100 ? "md" : "lg";
    const size = styled?.size
      ? Math.max(28, Math.min(72, Math.round(Number(styled.size))))
      : tier === "sm"
        ? 36
        : tier === "md"
          ? 44
          : 52;
    const className = [
      "oh-cluster-icon",
      `oh-cluster-icon--${tier}`,
      aggregates.containsSelected ? "oh-cluster-icon--selected" : ""
    ]
      .filter(Boolean)
      .join(" ");
    let content: string | Node = String(count);
    if (styled?.color && typeof document !== "undefined") {
      const node = document.createElement("span");
      node.textContent = String(count);
      node.style.display = "grid";
      node.style.placeItems = "center";
      node.style.width = "100%";
      node.style.height = "100%";
      node.style.borderRadius = "50%";
      node.style.background = styled.color;
      node.style.color = "#fff";
      content = node;
    }
    return new DivIcon({
      content,
      className,
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
    this._gpuSubset = false;
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
    this.scene.clearLayers();
    this.clusterMembers.clear();
    this._activeRenderer = "dom";
  }

  #objectPosition(item: ManagedObject): LatLngLike | null {
    const geometry = tryNormalizeManagedGeometry(item, {
      maxVertices: this.options.maxVerticesPerGeometry
    });
    if (!geometry) return null;
    if (geometry.kind === "Point") return { lat: geometry.lat, lng: geometry.lng };
    return { lat: (geometry.bbox[0] + geometry.bbox[2]) / 2, lng: (geometry.bbox[1] + geometry.bbox[3]) / 2 };
  }
}

export function objectManager(options?: ObjectManagerOptions): ObjectManager {
  return new ObjectManager(options);
}

function assertObjectStateValue(key: string, value: unknown): asserts value is ObjectStateValue {
  const type = typeof value;
  if (value === null || type === "string" || type === "number" || type === "boolean") {
    if (type === "number" && !Number.isFinite(value as number)) {
      throw new TypeError(`ObjectManager: state "${key}" must be a finite scalar`);
    }
    return;
  }
  throw new TypeError(`ObjectManager: state "${key}" must be a string, number, boolean, or null`);
}

function legacyObjectStyle(
  object: ManagedObject,
  state: Readonly<ObjectState>,
  context: Readonly<ObjectStyleContext>,
  styleByCategory: boolean
): ObjectStyle {
  if (!styleByCategory) {
    return {
      color: DEFAULT_OBJECT_COLOR,
      opacity: DEFAULT_OBJECT_OPACITY,
      size: DEFAULT_OBJECT_SIZE
    };
  }
  if (context.selected || state.selected) {
    return { color: PALETTE_HEX.selected, opacity: OBJECT_MANAGER_PALETTE.selected[3], size: DEFAULT_OBJECT_SIZE };
  }
  if (context.hovered || state.hovered) {
    return { color: PALETTE_HEX.hover, opacity: OBJECT_MANAGER_PALETTE.hover[3], size: DEFAULT_OBJECT_SIZE };
  }
  if (object.properties?.alert) {
    return { color: PALETTE_HEX.alert, opacity: OBJECT_MANAGER_PALETTE.alert[3], size: DEFAULT_OBJECT_SIZE };
  }
  const category = String(object.properties?.category || "alpha");
  if (category === "beta") {
    return { color: PALETTE_HEX.beta, opacity: OBJECT_MANAGER_PALETTE.beta[3], size: DEFAULT_OBJECT_SIZE };
  }
  if (category === "gamma") {
    return { color: PALETTE_HEX.gamma, opacity: OBJECT_MANAGER_PALETTE.gamma[3], size: DEFAULT_OBJECT_SIZE };
  }
  return { color: PALETTE_HEX.alpha, opacity: OBJECT_MANAGER_PALETTE.alpha[3], size: DEFAULT_OBJECT_SIZE };
}

function normalizeResolvedStyle(style: ObjectStyle): ResolvedObjectStyle {
  const fallbackRgb = parseCssColor(DEFAULT_OBJECT_COLOR, { r: 15, g: 118, b: 110 });
  const requestedFill = style.fill ?? style.color;
  const color = typeof requestedFill === "string" && requestedFill.trim() ? requestedFill : DEFAULT_OBJECT_COLOR;
  const rgb = parseCssColor(color, fallbackRgb);
  let opacity = Number(style.fillOpacity ?? style.opacity);
  if (!Number.isFinite(opacity)) opacity = DEFAULT_OBJECT_OPACITY;
  opacity = Math.max(0, Math.min(1, opacity));
  let size = Number(style.size);
  if (!Number.isFinite(size)) size = DEFAULT_OBJECT_SIZE;
  size = Math.max(1, Math.min(MAX_OBJECT_SIZE, size));
  let rotation = Number(style.rotation) || 0;
  rotation = ((rotation % 360) + 360) % 360;
  return {
    color,
    rgba: [rgb.r / 255, rgb.g / 255, rgb.b / 255, opacity],
    opacity,
    size,
    icon: style.icon ?? null,
    iconTint: typeof style.iconTint === "string" && style.iconTint.trim() ? style.iconTint : null,
    rotation,
    visible: style.visible !== false,
    label: normalizeLabel(style.label ?? null),
    collisionMode: style.collisionMode ?? "auto",
    trail: style.trail ?? null,
    line: style.line ?? null,
    polygon: style.polygon ?? null
  };
}
