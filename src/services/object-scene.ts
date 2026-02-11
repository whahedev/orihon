import type { Orihon } from "../map.js";
import { heatLayer, type HeatLayer } from "../layers/heat.js";
import type { HeatBackend, HeatMode, HeatEvaluation } from "./heat.js";
import { webglSymbolLayer, type WebGLSymbolLayer, type WebGLSymbolInstance } from "../layers/webgl-symbol-layer.js";
import { webglStyledPathBatch, type WebGLStyledPathBatch } from "../layers/webgl-styled-path-batch.js";
import { webglPolygonBatch, type WebGLPolygonBatch } from "../layers/webgl-polygon-batch.js";
import { ObjectIconAtlas, type ManagedIconOptions, type ManagedIconSource } from "./object-icon-atlas.js";
import { ObjectSearchIndex, type ObjectSearchOptions, type ObjectSearchResult } from "./object-search-index.js";
import { ObjectTimeIndex, type ObjectTimeConfig } from "./object-time-index.js";
import { ObjectTrailStore } from "./object-trail-store.js";
import { nonNegativeFinite } from "../units.js";
import {
  layoutObjectLabels,
  measureLabelText,
  type LabelCandidate
} from "./object-label-layout.js";
import {
  computeClusterAggregates,
  type ClusterPropertiesConfig,
  type ClusterAggregateValues
} from "./object-cluster-aggregates.js";
import type { NormalizedGeometry, NormalizedLineString, NormalizedPolygon } from "./object-geometry.js";
import type {
  ObjectId,
  ObjectStyle,
  ObjectLabelStyle,
  ObjectDirtyFlag
} from "./object-types.js";
import { ObjectDirtyFlags } from "./object-types.js";
import { normalizeLabel } from "./object-style-helpers.js";
export { normalizeLabel, styleTint } from "./object-style-helpers.js";

export type ObjectVisualizationMode = "objects" | "clusters" | "heatmap" | "auto";

export interface ObjectVisualizationByZoom {
  heatmapUntil?: number;
  clustersUntil?: number;
}

export interface ObjectLabelAnchor {
  id: ObjectId;
  lat: number;
  lng: number;
  text: string;
  font: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  priority: number;
  collisionMode: "auto" | "always" | "hide";
  color: string;
  haloColor: string;
  haloWidth: number;
}

export interface ObjectMotionState {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  startTimeMs: number;
  durationMs: number;
}

export interface ObjectSceneOptions {
  declutter?: boolean;
  visualization?: ObjectVisualizationMode;
  visualizationByZoom?: ObjectVisualizationByZoom;
  search?: { fields: string[]; normalize?: boolean } | null;
  time?: ObjectTimeConfig | null;
  clusterProperties?: ClusterPropertiesConfig;
  heatmapWeight?: ((object: { properties?: Record<string, unknown> }, id?: string | number) => number) | null;
  heatmapDisplay?: HeatMode;
  heatmapIsolineLabels?: boolean;
  heatmapBackend?: HeatBackend;
  heatmapEvaluation?: HeatEvaluation;
  heatmapIsolineStep?: "auto" | number;
}

/** Heatmap is the low-zoom view (auto until ~7). Bandwidth is defined there, not at city zoom. */
const OBJECT_HEAT_SCALE_ZOOM = 6;

function objectHeatLayerOptions(options: {
  display: HeatMode;
  labels: boolean;
  backend: HeatBackend;
  evaluation: HeatEvaluation;
  isolineStep: "auto" | number;
}) {
  return {
    pane: "overlay" as const,
    // Geographic stamps — avoid tight maxRadius clamps that change neighbourhood
    // size (and therefore red zones) between overview and city zoom.
    radius: 16,
    blur: 12,
    scaleZoom: OBJECT_HEAT_SCALE_ZOOM,
    mode: options.display,
    backend: options.backend,
    evaluation: options.evaluation,
    step: options.isolineStep,
    labels: options.labels,
    levels: 5,
    minOpacity: 0.05,
    opacity: 0.85,
    isolineWidth: 1.6,
    isolineOpacity: 0.9,
    // Full sensor range: cool→green, alarm threshold≈0.5→yellow, hot→red.
    gradient: {
      0: "rgba(34, 197, 94, 0.15)",
      0.22: "#22c55e",
      0.4: "#84cc16",
      0.5: "yellow",
      0.72: "orange",
      1: "red"
    }
  };
}

/**
 * Opt-in scene subsystems for ObjectManager: icons, labels, search, time,
 * trails, lines/polygons, heatmap visualization. Keeps object-manager.ts lean.
 */
export class ObjectSceneController {
  readonly atlas = new ObjectIconAtlas();
  readonly trails = new ObjectTrailStore();
  readonly motions = new Map<ObjectId, ObjectMotionState>();
  readonly geometries = new Map<ObjectId, NormalizedGeometry>();
  readonly dirty = new Map<ObjectId, number>();
  searchIndex: ObjectSearchIndex | null = null;
  timeIndex: ObjectTimeIndex | null = null;
  clusterProperties: ClusterPropertiesConfig = {};
  declutter = false;
  visualization: ObjectVisualizationMode = "objects";
  visualizationByZoom: ObjectVisualizationByZoom = { heatmapUntil: 7, clustersUntil: 12 };
  heatmapWeight: ((object: { properties?: Record<string, unknown> }, id?: string | number) => number) | null = null;
  heatmapDisplay: HeatMode = "heatmap";
  heatmapIsolineLabels = true;
  heatmapBackend: HeatBackend = "auto";
  heatmapEvaluation: HeatEvaluation = "static";
  heatmapIsolineStep: "auto" | number = "auto";

  symbolLayer: WebGLSymbolLayer | null = null;
  heatLayer: HeatLayer | null = null;
  pathBatch: WebGLStyledPathBatch | null = null;
  polygonBatch: WebGLPolygonBatch | null = null;
  labelCanvas: HTMLCanvasElement | null = null;
  private labelCtx: CanvasRenderingContext2D | null = null;
  private labelAnchors: ObjectLabelAnchor[] = [];
  private map: Orihon | null = null;
  private activeVisualization: "objects" | "clusters" | "heatmap" = "objects";
  private motionRaf = 0;
  /** Count of LineString/Polygon geometries (for skipping pointless scene sync). */
  private nonPointGeometryCount = 0;

  configure(options: ObjectSceneOptions): void {
    this.declutter = Boolean(options.declutter);
    this.visualization = options.visualization ?? "objects";
    this.visualizationByZoom = {
      heatmapUntil: options.visualizationByZoom?.heatmapUntil ?? 7,
      clustersUntil: options.visualizationByZoom?.clustersUntil ?? 12
    };
    this.clusterProperties = options.clusterProperties ?? {};
    this.heatmapWeight = options.heatmapWeight ?? null;
    this.heatmapDisplay = options.heatmapDisplay ?? "heatmap";
    this.heatmapIsolineLabels = options.heatmapIsolineLabels !== false;
    this.heatmapBackend = options.heatmapBackend ?? "auto";
    this.heatmapEvaluation = options.heatmapEvaluation ?? "static";
    this.heatmapIsolineStep = options.heatmapIsolineStep ?? "auto";
    this.searchIndex = options.search?.fields?.length
      ? new ObjectSearchIndex(options.search)
      : null;
    this.timeIndex = options.time ? new ObjectTimeIndex(options.time) : null;
  }

  attach(map: Orihon): void {
    this.map = map;
  }

  detach(): void {
    this.clearLayers();
    this.map = null;
    if (this.motionRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.motionRaf);
      this.motionRaf = 0;
    }
  }

  clear(): void {
    this.geometries.clear();
    this.nonPointGeometryCount = 0;
    this.dirty.clear();
    this.motions.clear();
    this.trails.clear();
    this.searchIndex?.clear();
    this.timeIndex?.clear();
    this.clearLayers();
  }

  clearHeat(): void {
    this.heatLayer?.remove();
    this.heatLayer = null;
  }

  clearNonHeatLayers(): void {
    this.symbolLayer?.remove();
    this.pathBatch?.remove();
    this.polygonBatch?.remove();
    this.symbolLayer = null;
    this.pathBatch = null;
    this.polygonBatch = null;
    this.labelAnchors = [];
    this.labelCanvas?.remove();
    this.labelCanvas = null;
    this.labelCtx = null;
  }

  clearLayers(): void {
    this.clearNonHeatLayers();
    this.clearHeat();
  }

  registerIcon(name: string, source: ManagedIconSource, options?: ManagedIconOptions): void {
    this.atlas.register(name, source, options);
    this.symbolLayer?.setAtlas(this.atlas);
  }

  removeIcon(name: string): void {
    this.atlas.remove(name);
    this.symbolLayer?.setAtlas(this.atlas);
  }

  clearIcons(): void {
    this.atlas.clear();
    this.symbolLayer?.setAtlas(this.atlas);
  }

  hasIcon(name: string): boolean {
    return this.atlas.has(name);
  }

  markDirty(id: ObjectId, flags: ObjectDirtyFlag): void {
    this.dirty.set(id, (this.dirty.get(id) ?? 0) | flags);
  }

  consumeDirty(): Map<ObjectId, number> {
    const out = new Map(this.dirty);
    this.dirty.clear();
    return out;
  }

  setGeometry(id: ObjectId, geometry: NormalizedGeometry): void {
    const prev = this.geometries.get(id);
    if (prev && prev.kind !== "Point") this.nonPointGeometryCount = Math.max(0, this.nonPointGeometryCount - 1);
    this.geometries.set(id, geometry);
    if (geometry.kind !== "Point") this.nonPointGeometryCount++;
    if (!prev || prev.kind !== geometry.kind) {
      this.markDirty(id, ObjectDirtyFlags.Geometry | ObjectDirtyFlags.Position);
    } else if (prev.kind === "Point" && geometry.kind === "Point") {
      if (prev.lat !== geometry.lat || prev.lng !== geometry.lng) {
        this.markDirty(id, ObjectDirtyFlags.Position);
      }
    } else {
      this.markDirty(id, ObjectDirtyFlags.Geometry | ObjectDirtyFlags.Position);
    }
  }

  removeGeometry(id: ObjectId): void {
    const prev = this.geometries.get(id);
    if (prev && prev.kind !== "Point") this.nonPointGeometryCount = Math.max(0, this.nonPointGeometryCount - 1);
    this.geometries.delete(id);
  }

  removeObject(id: ObjectId): void {
    this.removeGeometry(id);
    this.dirty.delete(id);
    this.motions.delete(id);
    this.trails.remove(id);
    this.searchIndex?.remove(id);
    this.timeIndex?.remove(id);
  }

  hasNonPointGeometries(): boolean {
    return this.nonPointGeometryCount > 0;
  }

  /** Reset geometry bookkeeping after a bulk `geometries.clear()`. */
  resetGeometryStats(): void {
    this.nonPointGeometryCount = 0;
  }

  resolveVisualization(zoom: number): "objects" | "clusters" | "heatmap" {
    if (this.visualization === "auto") {
      const heatUntil = this.visualizationByZoom.heatmapUntil ?? 7;
      const clustersUntil = this.visualizationByZoom.clustersUntil ?? 12;
      if (zoom < heatUntil) return "heatmap";
      if (zoom < clustersUntil) return "clusters";
      return "objects";
    }
    if (this.visualization === "heatmap") return "heatmap";
    if (this.visualization === "clusters") return "clusters";
    return "objects";
  }

  getActiveVisualization(): "objects" | "clusters" | "heatmap" {
    return this.activeVisualization;
  }

  setActiveVisualization(mode: "objects" | "clusters" | "heatmap"): boolean {
    if (this.activeVisualization === mode) return false;
    this.activeVisualization = mode;
    return true;
  }

  search(
    query: string,
    objects: Map<ObjectId, { properties?: Record<string, unknown>; [key: string]: unknown }>,
    options?: ObjectSearchOptions
  ): ObjectSearchResult[] {
    if (!this.searchIndex) return [];
    return this.searchIndex.search(query, objects, options);
  }

  setTimeRange(from: number | null, to: number | null): void {
    this.timeIndex?.setRange(from, to);
  }

  activeTimeIds(): Set<ObjectId> | null {
    return this.timeIndex?.queryActiveIds() ?? null;
  }

  startMotion(
    id: ObjectId,
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    durationMs: number
  ): void {
    nonNegativeFinite(durationMs, "durationMs");
    const now = performance.now();
    const existing = this.motions.get(id);
    let startLat = fromLat;
    let startLng = fromLng;
    if (existing) {
      const t = existing.durationMs === 0 ? 1 : Math.max(0, Math.min(1, (now - existing.startTimeMs) / existing.durationMs));
      startLat = existing.fromLat + (existing.toLat - existing.fromLat) * t;
      startLng = existing.fromLng + (existing.toLng - existing.fromLng) * t;
    }
    this.motions.set(id, {
      fromLat: startLat,
      fromLng: startLng,
      toLat,
      toLng,
      startTimeMs: now,
      durationMs: Math.max(0, durationMs)
    });
    this.#ensureMotionLoop();
  }

  visualPosition(id: ObjectId, fallbackLat: number, fallbackLng: number): { lat: number; lng: number } {
    const motion = this.motions.get(id);
    if (!motion) return { lat: fallbackLat, lng: fallbackLng };
    const now = performance.now();
    const t = motion.durationMs === 0 ? 1 : Math.max(0, Math.min(1, (now - motion.startTimeMs) / motion.durationMs));
    if (t >= 1) {
      this.motions.delete(id);
      return { lat: motion.toLat, lng: motion.toLng };
    }
    return {
      lat: motion.fromLat + (motion.toLat - motion.fromLat) * t,
      lng: motion.fromLng + (motion.toLng - motion.fromLng) * t
    };
  }

  syncSymbols(
    instances: WebGLSymbolInstance[],
    map: Orihon
  ): void {
    if (!instances.length) {
      this.symbolLayer?.remove();
      this.symbolLayer = null;
      return;
    }
    if (!this.symbolLayer) {
      this.symbolLayer = webglSymbolLayer({ pane: "marker", interactive: true, fallbackCanvas: true });
      this.symbolLayer.setAtlas(this.atlas);
      this.symbolLayer.addTo(map);
    }
    this.symbolLayer.setInstances(instances);
  }

  /** Patch in-flight GPU motion/rotation without rebuilding the whole symbol batch. */
  patchSymbolMotions(headingPatches: Array<{ id: ObjectId; rotation: number }> = []): void {
    const layer = this.symbolLayer;
    if (!layer) return;
    const byId = new Map(headingPatches.map((patch) => [patch.id, patch.rotation]));
    for (const [id, motion] of this.motions) {
      const patch: Partial<WebGLSymbolInstance> = {
        lat: motion.toLat,
        lng: motion.toLng,
        prevLat: motion.fromLat,
        prevLng: motion.fromLng,
        startTimeMs: motion.startTimeMs,
        durationMs: motion.durationMs
      };
      if (byId.has(id)) patch.rotation = byId.get(id);
      layer.patchById(id, patch);
    }
    for (const [id, rotation] of byId) {
      if (this.motions.has(id)) continue;
      layer.patchById(id, { rotation });
    }
  }

  syncHeat(
    points: Array<[number, number, number?]>,
    map: Orihon
  ): void {
    const hot = points.filter((p) => (p[2] == null ? 1 : Number(p[2])) > 1e-6);
    if (!hot.length) {
      this.heatLayer?.remove();
      this.heatLayer = null;
      return;
    }
    if (!this.heatLayer) {
      this.heatLayer = heatLayer(hot, objectHeatLayerOptions({
        display: this.heatmapDisplay,
        labels: this.heatmapIsolineLabels,
        backend: this.heatmapBackend,
        evaluation: this.heatmapEvaluation,
        isolineStep: this.heatmapIsolineStep
      }));
      this.heatLayer.addTo(map);
      return;
    }
    this.heatLayer.setData(hot);
  }

  syncHeatPacked(
    merc64: Float64Array,
    pointCount: number,
    map: Orihon,
    weights?: ArrayLike<number> | null
  ): void {
    if (pointCount <= 0) {
      this.heatLayer?.remove();
      this.heatLayer = null;
      return;
    }
    if (!this.heatLayer) {
      this.heatLayer = heatLayer([], objectHeatLayerOptions({
        display: this.heatmapDisplay,
        labels: this.heatmapIsolineLabels,
        backend: this.heatmapBackend,
        evaluation: this.heatmapEvaluation,
        isolineStep: this.heatmapIsolineStep
      }));
      this.heatLayer.addTo(map);
    }
    this.heatLayer.setPackedMercator(merc64, pointCount, weights);
  }

  syncPaths(
    paths: Parameters<WebGLStyledPathBatch["setPaths"]>[0],
    map: Orihon
  ): void {
    const list = [...paths];
    if (!list.length) {
      this.pathBatch?.remove();
      this.pathBatch = null;
      return;
    }
    if (!this.pathBatch) {
      this.pathBatch = webglStyledPathBatch({ pane: "overlay", interactive: true });
      this.pathBatch.addTo(map);
    }
    this.pathBatch.setPaths(list);
  }

  syncPolygons(
    polygons: Parameters<WebGLPolygonBatch["setPolygons"]>[0],
    map: Orihon
  ): void {
    const list = [...polygons];
    if (!list.length) {
      this.polygonBatch?.remove();
      this.polygonBatch = null;
      return;
    }
    if (!this.polygonBatch) {
      this.polygonBatch = webglPolygonBatch({ pane: "overlay", interactive: true });
      this.polygonBatch.addTo(map);
    }
    this.polygonBatch.setPolygons(list);
  }

  setLabelAnchors(anchors: ObjectLabelAnchor[]): void {
    this.labelAnchors = anchors;
  }

  /**
   * Reproject cached label anchors into screen space and redraw.
   * Used on every map `move` frame so labels track the camera with WebGL layers.
   */
  redrawLabels(map: Orihon, options: { declutter?: boolean } = {}): void {
    if (!this.labelAnchors.length && !this.labelCanvas) return;
    const pane = map.getPane?.("tooltip") ?? map.getPane?.("overlay");
    if (!pane) return;
    if (!this.labelCanvas) {
      this.labelCanvas = document.createElement("canvas");
      this.labelCanvas.className = "oh-object-labels";
      this.labelCanvas.style.position = "absolute";
      this.labelCanvas.style.left = "0";
      this.labelCanvas.style.top = "0";
      this.labelCanvas.style.pointerEvents = "none";
      this.labelCanvas.style.zIndex = "1";
      pane.appendChild(this.labelCanvas);
      this.labelCtx = this.labelCanvas.getContext("2d");
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { width, height } = map.size;
    if (this.labelCanvas.style.width !== `${width}px`) this.labelCanvas.style.width = `${width}px`;
    if (this.labelCanvas.style.height !== `${height}px`) this.labelCanvas.style.height = `${height}px`;
    const pixelW = Math.max(1, Math.round(width * dpr));
    const pixelH = Math.max(1, Math.round(height * dpr));
    if (this.labelCanvas.width !== pixelW) this.labelCanvas.width = pixelW;
    if (this.labelCanvas.height !== pixelH) this.labelCanvas.height = pixelH;
    const ctx = this.labelCtx;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!this.labelAnchors.length) return;

    const pad = 64;
    const candidates: LabelCandidate[] = [];
    for (const anchor of this.labelAnchors) {
      const screen = map.latLngToContainerPoint
        ? map.latLngToContainerPoint({ lat: anchor.lat, lng: anchor.lng })
        : map.latLngToLayerPoint({ lat: anchor.lat, lng: anchor.lng });
      if (
        screen.x < -pad ||
        screen.y < -pad ||
        screen.x > width + pad ||
        screen.y > height + pad
      ) {
        continue;
      }
      candidates.push({
        id: anchor.id,
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

    const useDeclutter = options.declutter ?? this.declutter;
    const layout = useDeclutter
      ? layoutObjectLabels(candidates, { padding: 4, maxLabels: 800 })
      : { visible: candidates.filter((c) => c.collisionMode !== "hide"), hidden: [] as LabelCandidate[] };

    const byId = new Map(this.labelAnchors.map((anchor) => [anchor.id, anchor]));
    for (const label of layout.visible) {
      const anchor = byId.get(label.id);
      if (!anchor) continue;
      ctx.font = anchor.font;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      if (anchor.haloWidth > 0) {
        ctx.lineWidth = anchor.haloWidth * 2;
        ctx.strokeStyle = anchor.haloColor;
        ctx.lineJoin = "round";
        ctx.strokeText(anchor.text, label.x, label.y);
      }
      ctx.fillStyle = anchor.color;
      ctx.fillText(anchor.text, label.x, label.y);
    }
  }

  drawLabels(
    candidates: LabelCandidate[],
    map: Orihon
  ): void {
    // Legacy entry: convert screen candidates are already positioned — keep for callers.
    // Prefer setLabelAnchors + redrawLabels for camera-tracking labels.
    void candidates;
    this.redrawLabels(map, { declutter: this.declutter });
  }

  buildLabelAnchor(
    id: ObjectId,
    style: ObjectStyle,
    lat: number,
    lng: number,
    ctx: CanvasRenderingContext2D | null
  ): ObjectLabelAnchor | null {
    if (style.visible === false) return null;
    const label = normalizeLabel(style.label);
    if (!label) return null;
    const fontSize = label.fontSize ?? 12;
    const family = label.fontFamily ?? "system-ui, sans-serif";
    // Omit weight unless explicitly set — bare `12px system-ui` matches textLayer defaults (not semi-bold).
    const font =
      label.fontWeight != null && label.fontWeight !== ""
        ? `${label.fontWeight} ${fontSize}px ${family}`
        : `${fontSize}px ${family}`;
    const metrics = ctx
      ? measureLabelText(ctx, label.text, font)
      : { width: label.text.length * fontSize * 0.55, height: fontSize };
    const offset = label.offset ?? [0, -18];
    const haloWidth = Math.max(0, Number(label.haloWidth) || 0);
    return {
      id,
      lat,
      lng,
      text: label.text,
      font,
      width: metrics.width,
      height: metrics.height,
      offsetX: offset[0],
      offsetY: offset[1],
      priority: Number(label.priority) || 0,
      collisionMode: style.collisionMode ?? "auto",
      color: label.color ?? "#111827",
      haloColor: label.haloColor ?? "#ffffff",
      haloWidth
    };
  }

  buildLabelCandidate(
    id: ObjectId,
    style: ObjectStyle,
    screenX: number,
    screenY: number,
    ctx: CanvasRenderingContext2D | null
  ): LabelCandidate | null {
    const anchor = this.buildLabelAnchor(id, style, 0, 0, ctx);
    if (!anchor) return null;
    return {
      id,
      text: anchor.text,
      x: screenX + anchor.offsetX,
      y: screenY + anchor.offsetY - anchor.height,
      width: anchor.width,
      height: anchor.height,
      priority: anchor.priority,
      collisionMode: anchor.collisionMode,
      kind: "label"
    };
  }

  aggregateCluster(
    ids: ObjectId[],
    objects: Map<ObjectId, { properties?: Record<string, unknown>; [key: string]: unknown }>,
    selectedId: ObjectId | null
  ): ClusterAggregateValues {
    return computeClusterAggregates(ids, objects, selectedId, this.clusterProperties);
  }

  lineGeometry(id: ObjectId): NormalizedLineString | null {
    const geometry = this.geometries.get(id);
    return geometry?.kind === "LineString" ? geometry : null;
  }

  polygonGeometry(id: ObjectId): NormalizedPolygon | null {
    const geometry = this.geometries.get(id);
    return geometry?.kind === "Polygon" ? geometry : null;
  }

  #ensureMotionLoop(): void {
    if (this.motionRaf || typeof requestAnimationFrame !== "function") return;
    const tick = (): void => {
      if (!this.motions.size) {
        this.motionRaf = 0;
        return;
      }
      this.symbolLayer?.render();
      this.motionRaf = requestAnimationFrame(tick);
    };
    this.motionRaf = requestAnimationFrame(tick);
  }
}
