import { createEl, listen, listenTap } from "../dom.js";
import { cameraWarpCss } from "../camera.js";
import { TILE_SIZE, bounds, projectMercator01, unproject, type LatLngLike, type LatLngBoundsLike, type Point } from "../geo.js";
import { Layer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { OverlayContent, PopupOptions, TooltipOptions } from "../overlays/div-overlay.js";
import {
  packHeatMercator,
  packHeatPoints,
  packHeatPointsAsync,
  packedHeatLatLngBounds,
  type HeatFieldAsyncDataOptions,
  type PackedHeatPoints
} from "../services/heat-field.js";
import {
  buildPackedHeat,
  type HeatBackend,
  type HeatMode,
  type HeatEvaluation,
  type HeatContour,
  type HeatGrid,
  type HeatOptions,
  type HeatPoint,
  type HeatProfile,
  type HeatResult
} from "../services/heat.js";
import { pickLabelAnchor } from "../services/label-layout.js";

export type HeatGradient = Record<number, string>;
export interface HeatAsyncDataOptions extends HeatFieldAsyncDataOptions {}

export interface HeatLayerOptions extends LayerOptions, HeatOptions {
  /** `static`: one full-dataset field; `zoom`: refine the field at each settled zoom. */
  evaluation?: HeatEvaluation;
  labels?: boolean;
  /** Absolute contour interval, or `"auto"` for a stable engineering step. */
  step?: "auto" | number;
  /** Fill contour zones from the same scalar grid in isolines-only mode. Default true. */
  bands?: boolean;
  /** Keep the complete evaluation domain in the lowest zone. Default true. */
  cover?: boolean;
  gradient?: HeatGradient;
  opacity?: number;
  minOpacity?: number;
  domainOpacity?: number;
  /** Fractional padding around the full source extent in static mode. Default 0.035. */
  domainPadding?: number;
  dynamic?: boolean;
  /** Run field + contour computation off the main thread when Worker is available. Default true. */
  worker?: boolean;
  pad?: number;
  isolineWidth?: number;
  isolineOpacity?: number;
  isolineLabelFormat?: (ring: HeatContour) => string;
  isolineLabelFont?: string;
  isolineLabelColor?: string | "auto";
  isolineLabelMinVertices?: number;
  /** Enable line/zone hover, click, query, popup and tooltip interaction. */
  interactive?: boolean;
  /** Extra screen-pixel tolerance for isoline hit testing. Default 6. */
  hitTolerance?: number;
  /** Redraw the hovered line or zone boundaries. Default true. */
  hoverHighlight?: boolean;
  /** Keep the clicked line or zone selected. Default true. */
  selectOnClick?: boolean;
  highlightColor?: string;
  selectionColor?: string;
  highlightWidth?: number;
}

export interface HeatFeature {
  kind: "line" | "zone";
  /** Bilinearly sampled scalar-field value at the pointer. */
  fieldValue: number;
  /** Exact contour value for a line; sampled field value for a zone. */
  value: number;
  /** Normalized field value against referenceMax/current peak. */
  t: number;
  /** Inclusive lower boundary of a zone. */
  lowerValue: number;
  /** Exclusive upper boundary; null for the topmost zone. */
  upperValue: number | null;
  /** Zone index or contour level index. */
  levelId: number;
  /** Present for line hits. */
  ringIndex?: number;
  ring?: HeatContour;
}

interface HeatScreenRing {
  ring: HeatContour;
  ringIndex: number;
  points: Array<{ x: number; y: number }>;
  pathLen: number;
  stroke: string;
}

interface ResolvedHeatLayerOptions extends LayerOptions, HeatOptions {
  mode: HeatMode;
  backend: HeatBackend;
  evaluation: HeatEvaluation;
  labels: boolean;
  step: "auto" | number;
  bands: boolean;
  cover: boolean;
  gradient: HeatGradient;
  opacity: number;
  minOpacity: number;
  domainOpacity: number;
  domainPadding: number;
  dynamic: boolean;
  worker: boolean;
  pad: number;
  isolineWidth: number;
  isolineOpacity: number;
  isolineLabelFormat: (ring: HeatContour) => string;
  isolineLabelFont: string;
  isolineLabelColor: string | "auto";
  isolineLabelMinVertices: number;
  interactive: boolean;
  hitTolerance: number;
  hoverHighlight: boolean;
  selectOnClick: boolean;
  highlightColor: string;
  selectionColor: string;
  highlightWidth: number;
}

export interface HeatLayerStats extends HeatProfile {
  rings: number;
  peak: number;
  renderMs: number;
  worker: boolean;
}

const DEFAULT_GRADIENT: HeatGradient = {
  0: "rgba(0, 64, 255, 0)",
  0.2: "#2563eb",
  0.4: "#06b6d4",
  0.58: "#84cc16",
  0.72: "#fde047",
  0.86: "#f97316",
  1: "#dc2626"
};

export interface HeatPointerDetail {
  originalEvent: MouseEvent | PointerEvent;
  latlng: ReturnType<Orihon["containerPointToLatLng"]>;
  containerPoint: { x: number; y: number };
  data: HeatFeature;
  feature: HeatFeature;
  index: number;
}

export interface HeatEventMap {
  select: { data: HeatFeature; feature: HeatFeature };
  unselect: { data: HeatFeature; feature: HeatFeature };
  rebuild: { stats: HeatLayerStats };
  click: HeatPointerDetail;
  contextmenu: HeatPointerDetail;
  mouseover: { originalEvent: MouseEvent; latlng: ReturnType<Orihon["containerPointToLatLng"]>; data: HeatFeature; feature: HeatFeature };
  mousemove: HeatEventMap["mouseover"];
  mouseout: { originalEvent: MouseEvent; latlng: ReturnType<Orihon["containerPointToLatLng"]> | null; data: HeatFeature; feature: HeatFeature };
  hover: { originalEvent: MouseEvent; latlng: ReturnType<Orihon["containerPointToLatLng"]> | null; containerPoint: { x: number; y: number } | null; data: HeatFeature | null; feature: HeatFeature | null };
}

/** One field, three views: continuous heat colors, isolines, or both. */
export class HeatLayer extends Layer<ResolvedHeatLayerOptions, HeatEventMap> {
  canvas: HTMLCanvasElement | null = null;
  private _fieldCanvas: HTMLCanvasElement | null = null;
  private _points: PackedHeatPoints = { data: new Float32Array(0), count: 0 };
  private _field: HeatGrid | null = null;
  private _rings: HeatContour[] = [];
  private _thresholds: number[] = [];
  private _profile: HeatProfile = emptyProfile();
  private _renderMs = 0;
  private _palette: Uint8ClampedArray | null = null;
  private _resolvedScaleZoom: number | null = null;
  private _buildPromise: Promise<void> | null = null;
  private _rebuildQueued = false;
  private _generation = 0;
  private _worker: Worker | null = null;
  private _workerDisabled = false;
  private _workerRevision = 0;
  private _workerSyncedRevision = -1;
  private _workerRequestId = 0;
  private _workerPending = new Map<number, (result: HeatResult | null) => void>();
  private _workerReady: Promise<void> | null = null;
  private _resolveWorkerReady: (() => void) | null = null;
  private _usedWorker = false;
  private _paintedZoom = Number.NaN;
  private _paintedOriginX = 0;
  private _paintedOriginY = 0;
  private _paintedPad = 0;
  private _screenRings: HeatScreenRing[] = [];
  private _hoverFeature: HeatFeature | null = null;
  private _selectedFeature: HeatFeature | null = null;
  private _interactionUnsub: (() => void) | null = null;
  private readonly _onMove = (): void => this.#warpSurface();
  private readonly _onSettle = (): void => {
    if (this.options.evaluation === "zoom") void this.rebuildAsync();
    else this.render();
  };

  constructor(points: Iterable<HeatPoint> = [], options: HeatLayerOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      radius: 28,
      blur: 16,
      levels: 5,
      mode: "heatmap",
      backend: "auto",
      evaluation: "static",
      labels: true,
      step: "auto",
      bands: true,
      cover: true,
      gradient: DEFAULT_GRADIENT,
      opacity: 0.86,
      minOpacity: 0.02,
      domainOpacity: 0.08,
      domainPadding: 0.035,
      dynamic: true,
      worker: true,
      pad: 0.12,
      isolineWidth: 1.75,
      isolineOpacity: 0.9,
      isolineLabelFormat: defaultLabelFormat,
      isolineLabelFont: "700 13px ui-sans-serif, system-ui, sans-serif",
      isolineLabelColor: "#0f172a",
      isolineLabelMinVertices: 3,
      interactive: false,
      hitTolerance: 6,
      hoverHighlight: true,
      selectOnClick: true,
      highlightColor: "#22d3ee",
      selectionColor: "#f59e0b",
      highlightWidth: 4,
      ...options
    });
    assertHeatMode(this.options.mode);
    assertHeatBackend(this.options.backend);
    assertHeatEvaluation(this.options.evaluation);
    assertHeatStep(this.options.step);
    this._points = packHeatPoints(points);
  }

  get count(): number {
    return this._points.count;
  }

  getStats(): HeatLayerStats {
    return {
      ...this._profile,
      rings: this._rings.length,
      peak: this._field?.peak ?? 0,
      renderMs: this._renderMs,
      worker: this._usedWorker
    };
  }

  getField(): HeatGrid | null {
    return this._field;
  }

  getIsolines(): HeatContour[] {
    return this._rings.slice();
  }

  setData(points: Iterable<HeatPoint>): this {
    this._points = packHeatPoints(points);
    this._workerRevision++;
    this.#queueRebuild();
    return this;
  }

  setLatLngs(points: Iterable<HeatPoint>): this {
    return this.setData(points);
  }

  /** Project a large source cooperatively and swap the packed field input atomically. */
  async setDataAsync(
    points: Iterable<HeatPoint> | AsyncIterable<HeatPoint>,
    options: HeatAsyncDataOptions = {}
  ): Promise<this> {
    this._points = await packHeatPointsAsync(points, options);
    this._workerRevision++;
    this.#queueRebuild();
    return this;
  }

  setPackedMercator(
    mercator: Float64Array | Float32Array,
    pointCount: number,
    weights?: ArrayLike<number> | null
  ): this {
    this._points = packHeatMercator(mercator, pointCount, weights);
    this._workerRevision++;
    this.#queueRebuild();
    return this;
  }

  clear(): this {
    this._points = { data: new Float32Array(0), count: 0 };
    this._workerRevision++;
    this._field = null;
    this._rings = [];
    this._thresholds = [];
    this._screenRings = [];
    this._hoverFeature = null;
    this.clearSelection();
    this._generation++;
    this.#refreshFieldCanvas();
    this.render();
    return this;
  }

  setMode(mode: HeatMode): this {
    if (mode !== "heatmap" && mode !== "isolines" && mode !== "both") {
      throw new TypeError(`Invalid heat mode: ${String(mode)}`);
    }
    if (this.options.mode === mode) return this;
    this.options.mode = mode;
    this.#queueRebuild();
    return this;
  }

  setBackend(backend: HeatBackend): this {
    if (backend !== "auto" && backend !== "wasm" && backend !== "webgpu") {
      throw new TypeError(`Invalid heatmap backend: ${String(backend)}`);
    }
    if (this.options.backend === backend) return this;
    this.options.backend = backend;
    this.#queueRebuild();
    return this;
  }

  setEvaluation(evaluation: HeatEvaluation): this {
    assertHeatEvaluation(evaluation);
    if (this.options.evaluation === evaluation) return this;
    this.options.evaluation = evaluation;
    this._field = null;
    this._rings = [];
    this._thresholds = [];
    this.#queueRebuild();
    return this;
  }

  setLabels(enabled: boolean): this {
    this.options.labels = Boolean(enabled);
    this.render();
    return this;
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.setInteractive(true);
    return super.bindPopup(content, options);
  }

  override bindTooltip(content: OverlayContent, options?: TooltipOptions): this {
    this.setInteractive(true);
    return super.bindTooltip(content, options);
  }

  setInteractive(enabled: boolean): this {
    this.options.interactive = Boolean(enabled);
    this.#syncInteraction();
    return this;
  }

  getHoveredFeature(): HeatFeature | null {
    return this._hoverFeature ? { ...this._hoverFeature } : null;
  }

  getSelectedFeature(): HeatFeature | null {
    return this._selectedFeature ? { ...this._selectedFeature } : null;
  }

  selectFeature(feature: HeatFeature | null): this {
    const previous = this._selectedFeature;
    if (heatFeatureKey(previous) === heatFeatureKey(feature)) return this;
    this._selectedFeature = feature ? { ...feature } : null;
    if (previous) this.emit("unselect", { data: previous, feature: previous });
    if (feature) this.emit("select", { data: feature, feature });
    this.render();
    return this;
  }

  clearSelection(): this {
    return this.selectFeature(null);
  }

  /** Identify a contour line first, otherwise the scalar zone at a map point. */
  getFeatureAt(target: Point, tolerance = this.options.hitTolerance): HeatFeature | null {
    if (!this.map || !this._field) return null;
    const sampled = this.#sampleField(target);
    if (!sampled) return null;
    if (this.options.mode !== "heatmap") {
      const line = this.#nearestLine(target, Math.max(0, tolerance) + this.options.isolineWidth / 2);
      if (line) {
        const thresholdIndex = this._thresholds.findIndex((value) => nearlyEqual(value, line.ring.value));
        return {
          kind: "line",
          fieldValue: sampled.value,
          value: line.ring.value,
          t: line.ring.t,
          lowerValue: line.ring.value,
          upperValue: line.ring.value,
          levelId: line.ring.levelId ?? Math.max(0, thresholdIndex),
          ringIndex: line.ringIndex,
          ring: line.ring
        };
      }
    }
    const thresholds = this._thresholds;
    let zone = 0;
    while (zone < thresholds.length && sampled.value >= thresholds[zone]) zone++;
    const normalizer = Math.max(this.options.referenceMax ?? this._field.peak, 1e-12);
    return {
      kind: "zone",
      fieldValue: sampled.value,
      value: sampled.value,
      t: clamp01(sampled.value / normalizer),
      lowerValue: zone > 0 ? thresholds[zone - 1] : 0,
      upperValue: zone < thresholds.length ? thresholds[zone] : null,
      levelId: zone
    };
  }

  queryHit(target: Point, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const feature = this.getFeatureAt(target, options.tolerance + this.options.hitTolerance);
    if (!feature) return null;
    return {
      layer: this,
      latlng: this.map.containerPointToLatLng(target),
      source: "canvas",
      index: feature.ringIndex ?? feature.levelId,
      feature
    };
  }

  setGradient(gradient: HeatGradient): this {
    this.options.gradient = { ...gradient };
    this._palette = null;
    this.#refreshFieldCanvas();
    this.render();
    return this;
  }

  rebuild(): this {
    void this.rebuildAsync();
    return this;
  }

  async rebuildAsync(): Promise<this> {
    if (!this.map) return this;
    if (this._buildPromise) {
      this._rebuildQueued = true;
      await this._buildPromise;
      return this;
    }
    this._buildPromise = (async () => {
      do {
        this._rebuildQueued = false;
        await this.#buildOnce();
      } while (this._rebuildQueued && this.map);
    })();
    try {
      await this._buildPromise;
    } finally {
      this._buildPromise = null;
    }
    return this;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this._workerDisabled = false;
    this._resolvedScaleZoom ??= this.options.scaleZoom ?? map.getZoom();
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-heat-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.transformOrigin = "0 0";
    this.#syncInteraction();
    map.on("move", this._onMove);
    if (this.options.dynamic) {
      map.on("moveend", this._onSettle);
      map.on("zoomend", this._onSettle);
      map.on("resize", this._onSettle);
    }
    void this.rebuildAsync();
  }

  override onRemove(): void {
    this._generation++;
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    this.#disposeWorker();
    this.map?.off("move", this._onMove);
    this.map?.off("moveend", this._onSettle);
    this.map?.off("zoomend", this._onSettle);
    this.map?.off("resize", this._onSettle);
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this._fieldCanvas = null;
    this._field = null;
    this._rings = [];
    this._thresholds = [];
    this._screenRings = [];
    this._hoverFeature = null;
    this._selectedFeature = null;
    this._paintedZoom = Number.NaN;
    super.onRemove();
  }

  override wantsFrameRender(): boolean {
    // The completed scalar surface is compositor-warped during camera motion.
    // Exact pixels/labels are rebuilt once the camera settles.
    return false;
  }

  override render(): void {
    const map = this.map;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const started = performance.now();
    const { width, height } = map.size;
    const pad = Math.round(Math.min(256, Math.max(64, Math.min(width, height) * 0.2)));
    const drawWidth = width + pad * 2;
    const drawHeight = height + pad * 2;
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const bw = Math.max(1, Math.round(drawWidth * dpr));
    const bh = Math.max(1, Math.round(drawHeight * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    canvas.style.left = `${-pad}px`;
    canvas.style.top = `${-pad}px`;
    canvas.style.width = `${drawWidth}px`;
    canvas.style.height = `${drawHeight}px`;
    canvas.style.transform = "none";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const palette = this.#gradientPalette();
    const cold = `rgba(${palette[0]},${palette[1]},${palette[2]},${clamp01(this.options.domainOpacity)})`;
    canvas.style.backgroundColor = this.options.cover ? cold : "";
    canvas.style.boxShadow = this.options.cover ? `0 0 0 100vmax ${cold}` : "";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, drawWidth, drawHeight);
    this._screenRings = [];
    if (!this._field) return;

    if (this._fieldCanvas) {
      const nw = fieldCorner(this._field, 0, 0);
      const se = fieldCorner(this._field, 1, 1);
      const topLeft = map.latLngToContainerPoint(nw as LatLngLike);
      const bottomRight = map.latLngToContainerPoint(se as LatLngLike);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        this._fieldCanvas,
        topLeft.x + pad,
        topLeft.y + pad,
        bottomRight.x - topLeft.x,
        bottomRight.y - topLeft.y
      );
    }
    if (this.options.mode !== "heatmap") {
      this.#drawIsolines(ctx, drawWidth, drawHeight, pad, pad);
    }
    this._paintedZoom = map.zoom;
    this._paintedOriginX = map.pixelOrigin.x - pad;
    this._paintedOriginY = map.pixelOrigin.y - pad;
    this._paintedPad = pad;
    this._renderMs = performance.now() - started;
  }

  #warpSurface(): void {
    const map = this.map;
    const canvas = this.canvas;
    if (!map || !canvas || !Number.isFinite(this._paintedZoom)) return;
    canvas.style.left = `${-this._paintedPad}px`;
    canvas.style.top = `${-this._paintedPad}px`;
    canvas.style.transform = cameraWarpCss(
      { x: this._paintedOriginX, y: this._paintedOriginY },
      this._paintedZoom,
      { x: map.pixelOrigin.x - this._paintedPad, y: map.pixelOrigin.y - this._paintedPad },
      map.zoom
    );
  }

  async #buildOnce(): Promise<void> {
    const map = this.map;
    if (!map) return;
    const generation = ++this._generation;
    const size = map.getSize();
    const evaluation = this.options.evaluation;
    const scaleZoom = evaluation === "zoom"
      ? map.getZoom()
      : this.options.scaleZoom ?? this._resolvedScaleZoom ?? map.getZoom();
    const kernelMerc = Math.max(4, (this.options.radius ?? 28) + (this.options.blur ?? 16)) /
      (TILE_SIZE * 2 ** Math.max(-24, Math.min(30, scaleZoom)));
    const source = this._points.bounds;
    const sourceSpan = source
      ? Math.max(source.eastMerc - source.westMerc, source.southMerc - source.northMerc)
      : 0;
    const domainPaddingMerc = Math.max(kernelMerc * 1.25, sourceSpan * Math.max(0, this.options.domainPadding));
    const staticBounds = packedHeatLatLngBounds(this._points, domainPaddingMerc);
    const area = evaluation === "static" && staticBounds
      ? bounds(staticBounds)
      : bounds(map.getBounds()).pad(this.options.pad);
    const mercWidth = Math.max(1e-12, projectWidth(area.west, area.east));
    const northMerc = projectY(area.north);
    const southMerc = projectY(area.south);
    const mercHeight = Math.max(1e-12, southMerc - northMerc);
    const defaultLongSide = evaluation === "static" ? 512 : Math.max(128, Math.round(Math.max(size.x, size.y) / 2));
    const aspect = mercWidth / mercHeight;
    const defaultCols = aspect >= 1 ? defaultLongSide : Math.max(96, Math.round(defaultLongSide * aspect));
    const defaultRows = aspect >= 1 ? Math.max(96, Math.round(defaultLongSide / aspect)) : defaultLongSide;
    const cols = this.options.cols ?? Math.min(1024, defaultCols);
    const rows = this.options.rows ?? Math.min(1024, defaultRows);
    const pipelineOptions: HeatOptions = {
      cols,
      rows,
      radius: this.options.radius,
      blur: this.options.blur,
      scaleZoom,
      zoom: map.getZoom(),
      levels: this.options.levels,
      step: this.options.step,
      maxIsolineLevels: this.options.maxIsolineLevels,
      adaptiveLevels: this.options.adaptiveLevels,
      validMask: this.options.validMask,
      outlierQuantiles: this.options.outlierQuantiles,
      candidateMultiplier: this.options.candidateMultiplier,
      coverageRadius: this.options.coverageRadius,
      minCandidateCells: this.options.minCandidateCells,
      minIsolineLength: this.options.minIsolineLength,
      minIsolineArea: this.options.minIsolineArea,
      coverageWeight: this.options.coverageWeight,
      rangeWeight: this.options.rangeWeight,
      redundancyWeight: this.options.redundancyWeight,
      fragmentWeight: this.options.fragmentWeight,
      referenceMax: this.options.referenceMax,
      minPeak: this.options.minPeak,
      webgpuThreshold: this.options.webgpuThreshold,
      mode: this.options.mode,
      backend: this.options.backend
    };
    const serialBounds = { south: area.south, west: area.west, north: area.north, east: area.east };
    let result = this.options.worker
      ? await this.#buildWithWorker(serialBounds, pipelineOptions)
      : null;
    this._usedWorker = result != null;
    if (generation !== this._generation || !this.map) return;
    result ??= await buildPackedHeat(this._points, serialBounds, pipelineOptions);
    if (!result || generation !== this._generation || !this.map) return;
    this._field = result.field;
    this._rings = result.rings;
    this._thresholds = result.thresholds;
    this._profile = result.profile;
    this.#refreshFieldCanvas();
    this.render();
    this.emit("rebuild", { stats: this.getStats() });
  }

  async #buildWithWorker(
    bounds: LatLngBoundsLike,
    options: HeatOptions
  ): Promise<HeatResult | null> {
    const worker = this.#ensureWorker();
    if (!worker) return null;
    this.#syncWorkerData(worker);
    const id = ++this._workerRequestId;
    return new Promise((resolve) => {
      this._workerPending.set(id, resolve);
      worker.postMessage({
        type: "build",
        id,
        revision: this._workerRevision,
        bounds,
        options
      });
    });
  }

  #primeWorker(): Promise<void> {
    const worker = this.#ensureWorker();
    if (worker) this.#syncWorkerData(worker);
    return this._workerReady ?? Promise.resolve();
  }

  #syncWorkerData(worker: Worker): void {
    if (this._workerSyncedRevision === this._workerRevision) return;
    const data = this._points.data.slice();
    worker.postMessage({
      type: "data",
      revision: this._workerRevision,
      data,
      count: this._points.count,
      bounds: this._points.bounds
    }, [data.buffer]);
    this._workerSyncedRevision = this._workerRevision;
  }

  #ensureWorker(): Worker | null {
    if (this._worker) return this._worker;
    if (this._workerDisabled || typeof Worker === "undefined") return null;
    try {
      const moduleUrl = new URL(import.meta.url);
      const workerUrl = moduleUrl.pathname.includes("/layers/heat.js")
        ? new URL("../services/heat-worker.js", moduleUrl)
        : new URL("./services/heat-worker.js", moduleUrl);
      const worker = new Worker(workerUrl, { type: "module", name: "orihon-heat" });
      this._workerReady = new Promise((resolve) => { this._resolveWorkerReady = resolve; });
      worker.onmessage = (event: MessageEvent<{
        type: "ready" | "result" | "error";
        id?: number;
        result?: HeatResult | null;
      }>): void => {
        if (event.data.type === "ready") {
          this._resolveWorkerReady?.();
          this._resolveWorkerReady = null;
          return;
        }
        if (event.data.id == null) return;
        const pending = this._workerPending.get(event.data.id);
        if (!pending) return;
        this._workerPending.delete(event.data.id);
        pending(event.data.type === "result" ? event.data.result ?? null : null);
      };
      worker.onerror = (): void => {
        this._workerDisabled = true;
        this._resolveWorkerReady?.();
        this._resolveWorkerReady = null;
        this.#disposeWorker();
      };
      this._worker = worker;
      return worker;
    } catch {
      this._workerDisabled = true;
      return null;
    }
  }

  #disposeWorker(): void {
    this._resolveWorkerReady?.();
    this._resolveWorkerReady = null;
    this._workerReady = null;
    this._worker?.terminate();
    this._worker = null;
    this._workerSyncedRevision = -1;
    for (const resolve of this._workerPending.values()) resolve(null);
    this._workerPending.clear();
  }

  #queueRebuild(): void {
    if (!this.map) return;
    if (this._buildPromise) this._rebuildQueued = true;
    else void this.rebuildAsync();
  }

  #refreshFieldCanvas(): void {
    const field = this._field;
    const banded = this.options.mode === "isolines" && this.options.bands;
    if (!field || (this.options.mode === "isolines" && !banded) || typeof document === "undefined") {
      this._fieldCanvas = null;
      return;
    }
    const canvas = this._fieldCanvas ?? document.createElement("canvas");
    canvas.width = field.cols;
    canvas.height = field.rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(field.cols, field.rows);
    const palette = this.#gradientPalette();
    const normalizer = Math.max(this.options.referenceMax ?? field.peak, 1e-12);
    // Zero is part of the field legend: keep it blue in every display mode,
    // with a broad feather so the finite computation extent has no hard edge.
    const cellMercX = field.widthMerc / Math.max(field.cols - 1, 1);
    const cellMercY = field.heightMerc / Math.max(field.rows - 1, 1);
    const featherX = Math.max(1, field.kernelMerc / cellMercX * 1.25, field.cols * 0.1);
    const featherY = Math.max(1, field.kernelMerc / cellMercY * 1.25, field.rows * 0.1);
    for (let i = 0; i < field.grid.length; i++) {
      let value = field.grid[i];
      if (banded) {
        let band = 0;
        for (let level = 0; level < this._thresholds.length && value >= this._thresholds[level]; level++) {
          band = this._thresholds[level];
        }
        value = band;
      }
      // Log compression stops a few dense hubs from hiding the broad, weak
      // surface. Scalar values remain untouched for contours and labels.
      const t = Math.log1p(48 * clamp01(value / normalizer)) / 3.8918203;
      const p = Math.min(255, Math.round(t * 255)) * 4;
      const o = i * 4;
      image.data[o] = palette[p];
      image.data[o + 1] = palette[p + 1];
      image.data[o + 2] = palette[p + 2];
      const x = i % field.cols;
      const y = Math.floor(i / field.cols);
      const edgeX = Math.min(x, field.cols - 1 - x) / featherX;
      const edgeY = Math.min(y, field.rows - 1 - y) / featherY;
      const edge = clamp01(Math.min(edgeX, edgeY));
      const domainMask = edge * edge * (3 - 2 * edge);
      const alpha = t <= 0
        ? 0
        : (this.options.minOpacity + (this.options.opacity - this.options.minOpacity) * t) * domainMask;
      const paletteAlpha = palette[p + 3] / 255;
      image.data[o + 3] = Math.round(paletteAlpha * clamp01(alpha) * 255);
    }
    ctx.putImageData(image, 0, 0);
    this._fieldCanvas = canvas;
  }

  #drawIsolines(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    offsetX = 0,
    offsetY = 0
  ): void {
    if (!this.map || !this._rings.length) return;
    const screenRings: HeatScreenRing[] = [];
    const interactionRings: HeatScreenRing[] = [];
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = this.options.isolineOpacity;
    ctx.lineWidth = this.options.isolineWidth;
    for (let ringIndex = 0; ringIndex < this._rings.length; ringIndex++) {
      const ring = this._rings[ringIndex];
      if (ring.coordinates.length < 2) continue;
      const stroke = "#fff";
      const points: Array<{ x: number; y: number }> = [];
      const interactionPoints: Array<{ x: number; y: number }> = [];
      let pathLen = 0;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      for (let i = 0; i < ring.coordinates.length; i++) {
        const [lat, lng] = ring.coordinates[i];
        const p = this.map.latLngToContainerPoint({ lat, lng });
        interactionPoints.push({ x: p.x, y: p.y });
        const point = { x: p.x + offsetX, y: p.y + offsetY };
        if (i === 0) ctx.moveTo(point.x, point.y);
        else {
          ctx.lineTo(point.x, point.y);
          const previous = points[points.length - 1];
          pathLen += Math.hypot(point.x - previous.x, point.y - previous.y);
        }
        points.push(point);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = this.options.isolineWidth;
      ctx.stroke();
      screenRings.push({ ring, ringIndex, points, pathLen, stroke });
      interactionRings.push({ ring, ringIndex, points: interactionPoints, pathLen, stroke });
    }
    ctx.restore();
    this._screenRings = interactionRings;
    this.#drawInteractionHighlights(ctx, screenRings);
    if (this.options.labels) this.#drawLabels(ctx, screenRings, width, height);
  }

  #drawLabels(
    ctx: CanvasRenderingContext2D,
    rings: HeatScreenRing[],
    width: number,
    height: number
  ): void {
    const byLevel = new Map<string, (typeof rings)[number]>();
    for (const item of rings) {
      if (item.points.length < this.options.isolineLabelMinVertices) continue;
      const key = item.ring.t.toFixed(4);
      const previous = byLevel.get(key);
      if (!previous || item.pathLen > previous.pathLen) byLevel.set(key, item);
    }
    ctx.save();
    ctx.font = this.options.isolineLabelFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const item of byLevel.values()) {
      const text = this.options.isolineLabelFormat(item.ring);
      const anchor = text ? pickLabelAnchor(item.points, item.pathLen, width, height) : null;
      if (!anchor) continue;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.strokeText(text, anchor.x, anchor.y);
      ctx.fillStyle = this.options.isolineLabelColor === "auto" ? item.stroke : this.options.isolineLabelColor;
      ctx.fillText(text, anchor.x, anchor.y);
    }
    ctx.restore();
  }

  #drawInteractionHighlights(ctx: CanvasRenderingContext2D, rings: HeatScreenRing[]): void {
    const draw = (feature: HeatFeature | null, color: string, extraWidth: number): void => {
      if (!feature) return;
      const boundaries = feature.kind === "line"
        ? rings.filter((item) => item.ringIndex === feature.ringIndex)
        : rings.filter((item) =>
          nearlyEqual(item.ring.value, feature.lowerValue) ||
          (feature.upperValue != null && nearlyEqual(item.ring.value, feature.upperValue))
        );
      if (!boundaries.length) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.96;
      ctx.lineWidth = Math.max(this.options.isolineWidth + extraWidth, this.options.highlightWidth);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const item of boundaries) {
        if (item.points.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(item.points[0].x, item.points[0].y);
        for (let index = 1; index < item.points.length; index++) ctx.lineTo(item.points[index].x, item.points[index].y);
        ctx.stroke();
      }
      ctx.restore();
    };
    draw(this._selectedFeature, this.options.selectionColor, 2);
    if (this.options.hoverHighlight) draw(this._hoverFeature, this.options.highlightColor, 1);
  }

  #sampleField(target: Point): { value: number } | null {
    const map = this.map;
    const field = this._field;
    if (!map || !field || field.cols < 1 || field.rows < 1) return null;
    const latlng = map.containerPointToLatLng(target);
    const merc = projectMercator01(latlng.lat, latlng.lng);
    let offsetX = merc.x - field.westMerc;
    if (offsetX < 0) offsetX += 1;
    const u = offsetX / Math.max(field.widthMerc, 1e-12);
    const v = (merc.y - field.northMerc) / Math.max(field.heightMerc, 1e-12);
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const gx = u * Math.max(0, field.cols - 1);
    const gy = v * Math.max(0, field.rows - 1);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(field.cols - 1, x0 + 1);
    const y1 = Math.min(field.rows - 1, y0 + 1);
    const tx = gx - x0;
    const ty = gy - y0;
    const a = field.grid[y0 * field.cols + x0] || 0;
    const b = field.grid[y0 * field.cols + x1] || 0;
    const c = field.grid[y1 * field.cols + x0] || 0;
    const d = field.grid[y1 * field.cols + x1] || 0;
    return { value: (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty };
  }

  #nearestLine(target: Point, tolerance: number): HeatScreenRing | null {
    let nearest: HeatScreenRing | null = null;
    let nearestDistance = tolerance;
    for (const item of this._screenRings) {
      for (let index = 1; index < item.points.length; index++) {
        const distance = segmentDistance(target, item.points[index - 1], item.points[index]);
        if (distance <= nearestDistance) {
          nearest = item;
          nearestDistance = distance;
        }
      }
    }
    return nearest;
  }

  #syncInteraction(): void {
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    const canvas = this.canvas;
    const interactionRoot = this.map?.container;
    if (!canvas || !interactionRoot) return;
    canvas.classList.toggle("oh-interactive", this.options.interactive);
    canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    canvas.style.cursor = this.options.interactive ? "crosshair" : "";
    if (this.options.interactive) canvas.setAttribute("aria-label", "Interactive heatmap and isolines");
    else canvas.removeAttribute("aria-label");
    if (!this.options.interactive) return;
    const eventFeature = (event: MouseEvent | PointerEvent): {
      target: Point;
      latlng: ReturnType<Orihon["containerPointToLatLng"]>;
      feature: HeatFeature | null;
    } | null => {
      if (!this.map) return null;
      const rect = this.map.container.getBoundingClientRect();
      const target = { x: event.clientX - rect.left, y: event.clientY - rect.top } as Point;
      return { target, latlng: this.map.containerPointToLatLng(target), feature: this.getFeatureAt(target) };
    };
    const unsubs = [
      listenTap(canvas, (event) => {
        const hit = eventFeature(event);
        if (!hit?.feature) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.options.selectOnClick) this.selectFeature(hit.feature);
        this.emit("click", {
          originalEvent: event,
          latlng: hit.latlng,
          containerPoint: hit.target,
          data: hit.feature,
          feature: hit.feature,
          index: hit.feature.ringIndex ?? hit.feature.levelId
        });
      }),
      listen(interactionRoot, "mousemove", (event) => {
        if ((event.target as Element | null)?.closest?.(".oh-control, .oh-marker, .oh-popup, .oh-tooltip")) return;
        const hit = eventFeature(event);
        if (!hit) return;
        const previous = this._hoverFeature;
        const changed = heatFeatureKey(previous) !== heatFeatureKey(hit.feature);
        if (changed && previous) this.emit("mouseout", { originalEvent: event, latlng: hit.latlng, data: previous, feature: previous });
        this._hoverFeature = hit.feature;
        canvas.style.cursor = hit.feature ? "pointer" : "crosshair";
        if (changed && this.options.hoverHighlight) this.render();
        if (changed && hit.feature) this.emit("mouseover", { originalEvent: event, latlng: hit.latlng, data: hit.feature, feature: hit.feature });
        if (hit.feature) this.emit("mousemove", { originalEvent: event, latlng: hit.latlng, data: hit.feature, feature: hit.feature });
        this.emit("hover", {
          originalEvent: event,
          latlng: hit.feature ? hit.latlng : null,
          containerPoint: hit.target,
          data: hit.feature,
          feature: hit.feature
        });
      }, true),
      listen(interactionRoot, "mouseleave", (event) => {
        const previous = this._hoverFeature;
        this._hoverFeature = null;
        canvas.style.cursor = "crosshair";
        if (previous) this.emit("mouseout", { originalEvent: event, latlng: null, data: previous, feature: previous });
        this.emit("hover", { originalEvent: event, latlng: null, containerPoint: null, data: null, feature: null });
        if (previous && this.options.hoverHighlight) this.render();
      }),
      listen(canvas, "contextmenu", (event) => {
        const hit = eventFeature(event);
        if (!hit?.feature) return;
        event.preventDefault();
        event.stopPropagation();
        this.emit("contextmenu", {
          originalEvent: event,
          latlng: hit.latlng,
          containerPoint: hit.target,
          data: hit.feature,
          feature: hit.feature,
          index: hit.feature.ringIndex ?? hit.feature.levelId
        });
      })
    ];
    this._interactionUnsub = () => { for (const off of unsubs) off(); };
  }

  #gradientPalette(): Uint8ClampedArray {
    if (this._palette) return this._palette;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return new Uint8ClampedArray(1024);
    const gradient = ctx.createLinearGradient(0, 0, 256, 0);
    const stops = Object.entries(this.options.gradient)
      .map(([value, color]) => [Number(value), color] as const)
      .filter(([value]) => Number.isFinite(value))
      .sort((a, b) => a[0] - b[0]);
    if (!stops.length) stops.push([0, "blue"], [1, "red"]);
    for (const [stop, color] of stops) gradient.addColorStop(clamp01(stop), color);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 1);
    this._palette = ctx.getImageData(0, 0, 256, 1).data;
    return this._palette;
  }
}

export function heatLayer(
  points?: Iterable<HeatPoint>,
  options?: HeatLayerOptions
): HeatLayer {
  return new HeatLayer(points, options);
}

function fieldCorner(field: HeatGrid, x: 0 | 1, y: 0 | 1): LatLngLike {
  const point = unproject([
    (field.westMerc + field.widthMerc * x) * TILE_SIZE,
    (field.northMerc + field.heightMerc * y) * TILE_SIZE
  ], 0);
  return point;
}

function projectWidth(west: number, east: number): number {
  const w = projectMercator01(0, west).x;
  const e = projectMercator01(0, east).x;
  return e >= w ? e - w : e + 1 - w;
}

function projectY(lat: number): number {
  return projectMercator01(lat, 0).y;
}

function defaultLabelFormat(ring: HeatContour): string {
  const value = ring.value;
  if (!Number.isFinite(value)) return "";
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function heatFeatureKey(feature: HeatFeature | null): string {
  if (!feature) return "";
  return feature.kind === "line"
    ? `line:${feature.ringIndex ?? feature.levelId}`
    : `zone:${feature.levelId}`;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(a), Math.abs(b)) * 1e-6;
}

function segmentDistance(
  target: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(target.x - a.x, target.y - a.y);
  const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(target.x - (a.x + dx * t), target.y - (a.y + dy * t));
}

function assertHeatMode(value: string): asserts value is HeatMode {
  if (value !== "heatmap" && value !== "isolines" && value !== "both") {
    throw new TypeError(`Invalid heat mode: ${String(value)}`);
  }
}

function assertHeatBackend(value: string): asserts value is HeatBackend {
  if (value !== "auto" && value !== "wasm" && value !== "webgpu") {
    throw new TypeError(`Invalid heatmap backend: ${String(value)}`);
  }
}

function assertHeatEvaluation(value: string): asserts value is HeatEvaluation {
  if (value !== "static" && value !== "zoom") {
    throw new TypeError(`Invalid heatmap evaluation: ${String(value)}`);
  }
}

function assertHeatStep(value: "auto" | number): void {
  if (value !== "auto" && (!Number.isFinite(value) || value <= 0)) {
    throw new TypeError(`Invalid heatmap isoline step: ${String(value)}`);
  }
}

function emptyProfile(): HeatProfile {
  return {
    requestedBackend: "auto",
    backend: "js",
    mode: "heatmap",
    points: 0,
    cols: 0,
    rows: 0,
    fieldMs: 0,
    contoursMs: 0,
    readbackMs: 0,
    totalMs: 0,
    fieldModel: "clustered-gaussian"
  };
}
