import { LatLng, LatLngBounds, latLng, type LatLngLike } from "../geo.js";
import { FeatureGroup } from "../layer-group.js";
import { Layer, type LayerOptions } from "../layer.js";
import {
  asyncAbortError,
  isAsyncIterable,
  resolveAsyncBatchOptions,
  throwIfAsyncAborted,
  yieldAsyncBatch,
  type AsyncBatchOptions,
  type ResolvedAsyncBatchOptions
} from "../services/async-batch.js";
import type {
  OverlayContent,
  OverlayContentContext,
  OverlayRenderable,
  PopupOptions
} from "../overlays/div-overlay.js";
import { CanvasPathBatch } from "./canvas-path-batch.js";
import { Marker } from "./marker.js";
import {
  PathLayer,
  projectedBounds,
  projectedBoundsIntersectsViewport,
  projectedPointsToPath,
  simplifyProjectedPoints,
  type PathOptions
} from "./vector.js";

/**
 * Optional GPU path batch for GeoJSON (Advanced tier).
 * Standard keeps SVG/canvas only — register from `orihon` entry, not `orihon/standard`.
 */
export type GeoJSONPathBatch = Layer & {
  addPath(rings: LatLngLike[][], closed?: boolean, style?: PathOptions, feature?: GeoJSONFeature): unknown;
  clearPaths(): unknown;
  render(): void;
};

export type GeoJSONWebGLBatchFactory = (
  options: LayerOptions & PathOptions & { interactive?: boolean; className?: string }
) => GeoJSONPathBatch;

let webglBatchFactory: GeoJSONWebGLBatchFactory | null = null;

/** Advanced entry calls this so `renderer: "webgl" | "auto"` can use GPU lines. */
export function registerGeoJSONWebGLBatch(factory: GeoJSONWebGLBatchFactory | null): void {
  webglBatchFactory = factory;
}

function isPathBatch(layer: Layer): layer is GeoJSONPathBatch {
  const candidate = layer as Layer & Partial<GeoJSONPathBatch>;
  return typeof candidate.addPath === "function" && typeof candidate.clearPaths === "function";
}

export type GeoJSONPosition = [number, number, ...number[]];

export interface GeoJSONPointGeometry {
  type: "Point";
  coordinates: GeoJSONPosition;
}

export interface GeoJSONMultiPointGeometry {
  type: "MultiPoint";
  coordinates: GeoJSONPosition[];
}

export interface GeoJSONLineStringGeometry {
  type: "LineString";
  coordinates: GeoJSONPosition[];
}

export interface GeoJSONMultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: GeoJSONPosition[][];
}

export interface GeoJSONPolygonGeometry {
  type: "Polygon";
  coordinates: GeoJSONPosition[][];
}

export interface GeoJSONMultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: GeoJSONPosition[][][];
}

export interface GeoJSONGeometryCollection {
  type: "GeometryCollection";
  geometries: GeoJSONGeometry[];
}

export type GeoJSONGeometry =
  | GeoJSONPointGeometry
  | GeoJSONMultiPointGeometry
  | GeoJSONLineStringGeometry
  | GeoJSONMultiLineStringGeometry
  | GeoJSONPolygonGeometry
  | GeoJSONMultiPolygonGeometry
  | GeoJSONGeometryCollection;

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry | null;
  properties?: Record<string, unknown> | null;
  id?: string | number;
  bbox?: number[];
}

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
  bbox?: number[];
}

export type GeoJSONData = GeoJSONGeometry | GeoJSONFeature | GeoJSONFeatureCollection | GeoJSONData[];
export type GeoJSONAsyncInput = GeoJSONData | string | Blob | AsyncIterable<GeoJSONData>;
export type GeoJSONStyleFunction = (feature: GeoJSONFeature) => PathOptions;
export type GeoJSONPointToLayer = (feature: GeoJSONFeature, latlng: LatLng) => Layer;
export type GeoJSONPopupFactory = (
  feature: GeoJSONFeature,
  layer: Layer,
  context: OverlayContentContext
) => OverlayRenderable | Promise<OverlayRenderable>;
export type GeoJSONPopupContent = OverlayContent | GeoJSONPopupFactory;
/** svg = DOM per feature; canvas = CPU batch; webgl = GPU lines (Advanced, after register). */
export type GeoJSONRendererMode = "svg" | "canvas" | "webgl" | "auto";

export interface GeoJSONAsyncOptions extends AsyncBatchOptions {
  /** Parse string/Blob input in a dedicated worker when available. Default true. */
  useWorker?: boolean;
  /** Maximum UTF-8 bytes accepted from string/Blob input. Default 256 MiB. */
  maxBytes?: number;
}

interface ResolvedGeoJSONAsyncOptions extends ResolvedAsyncBatchOptions {
  useWorker: boolean;
  maxBytes: number;
}

export interface GeoJSONOptions extends PathOptions {
  style?: PathOptions | GeoJSONStyleFunction;
  pointToLayer?: GeoJSONPointToLayer;
  filter?: (feature: GeoJSONFeature) => boolean;
  onEachFeature?: (feature: GeoJSONFeature, layer: Layer) => void;
  coordsToLatLng?: (coordinates: GeoJSONPosition) => LatLngLike;
  popup?: GeoJSONPopupContent;
  popupOptions?: PopupOptions;
  /**
   * Vector backend.
   * - `auto` — SVG for small sets; canvas (Standard) or WebGL (Advanced, if registered) when ≥ `canvasThreshold`
   * - `webgl` — GPU batch when Advanced backend is registered; otherwise canvas
   */
  renderer?: GeoJSONRendererMode;
  /** Path-feature count that triggers canvas/webgl in `auto` mode. Default 250. */
  canvasThreshold?: number;
  /** Stop adding features once this many are stored. Unset = unlimited. */
  maxFeatures?: number;
  /**
   * Keep source features for `toGeoJSON()`, later feature-style updates and
   * inspection. Set `false` for write-once canvas/WebGL path batches when the
   * source collection is very large. Point layers are always retained.
   * Default `true`.
   */
  retainFeatures?: boolean;
}

interface FeatureEntry {
  feature: GeoJSONFeature;
  layer: Layer;
}

type FeatureLayer = Layer & { feature?: GeoJSONFeature };

type PathGeometry =
  | GeoJSONLineStringGeometry
  | GeoJSONMultiLineStringGeometry
  | GeoJSONPolygonGeometry
  | GeoJSONMultiPolygonGeometry;

const SPECIAL_OPTION_KEYS = new Set([
  "style",
  "pointToLayer",
  "filter",
  "onEachFeature",
  "coordsToLatLng",
  "popup",
  "popupOptions",
  "renderer",
  "canvasThreshold",
  "maxFeatures",
  "retainFeatures"
]);

const PATH_GEOMETRY_TYPES = new Set([
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon"
]);

const DEFAULT_ASYNC_GEOJSON_BYTES = 256 * 1024 * 1024;

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function* iterateGeoJSONItems(data: GeoJSONData): Generator<GeoJSONData> {
  if (Array.isArray(data)) {
    for (const item of data) yield* iterateGeoJSONItems(item);
    return;
  }
  if (data.type === "FeatureCollection") {
    for (const feature of data.features) yield feature;
    return;
  }
  yield data;
}

function topLevelGeoJSONCount(data: GeoJSONData): number | null {
  if (Array.isArray(data)) {
    let total = 0;
    for (const item of data) total += topLevelGeoJSONCount(item) ?? 0;
    return total;
  }
  if (data.type === "FeatureCollection") return data.features.length;
  return 1;
}

// Compact because this literal ships in the Standard bundle. Array messages
// also keep the million-feature backpressure protocol small and allocation-light.
const GEOJSON_PARSE_WORKER_SOURCE = `let a=null,i=0,n=0,t=0;function s(){if(!a)return;let e=Math.min(t,i+n),c=a.slice(i,e);for(;i<e;)a[i++]=null;postMessage([c,i,t,i>=t]);if(i>=t)a=null}onmessage=async e=>{let d=e.data;if(d===0)return s();try{let p=JSON.parse(await d[0].text());a=Array.isArray(p)?p:p&&p.type==="FeatureCollection"?p.features:[p];i=0;t=a.length;n=Math.max(1,d[1]|0);s()}catch(e){postMessage([null,String(e&&e.message||e)])}}`;

function geoJSONCoordsToLatLng(coordinates: GeoJSONPosition): LatLng {
  return latLng([Number(coordinates[1]), Number(coordinates[0])]);
}

function latLngToGeoJSONCoords(value: LatLngLike, precision = 6): GeoJSONPosition {
  const position = latLng(value);
  const factor = 10 ** Math.max(0, precision);
  return [Math.round(position.lng * factor) / factor, Math.round(position.lat * factor) / factor];
}

function geoJSONAsFeature(value: GeoJSONFeature | GeoJSONGeometry): GeoJSONFeature {
  return value.type === "Feature"
    ? value
    : { type: "Feature", properties: {}, geometry: value };
}

function countPathFeatures(data: GeoJSONData | null | undefined): number {
  if (!data) return 0;
  if (Array.isArray(data)) {
    let total = 0;
    for (const item of data) total += countPathFeatures(item);
    return total;
  }
  if (data.type === "FeatureCollection") {
    let total = 0;
    for (const feature of data.features) {
      if (feature.geometry && PATH_GEOMETRY_TYPES.has(feature.geometry.type)) total += 1;
    }
    return total;
  }
  if (data.type === "Feature") {
    return data.geometry && PATH_GEOMETRY_TYPES.has(data.geometry.type) ? 1 : 0;
  }
  return PATH_GEOMETRY_TYPES.has(data.type) ? 1 : 0;
}

class GeoJSONPathLayer extends PathLayer {
  readonly geometry: PathGeometry;
  readonly convert: (coordinates: GeoJSONPosition) => LatLng;

  constructor(
    geometry: PathGeometry,
    options: PathOptions,
    convert: (coordinates: GeoJSONPosition) => LatLng
  ) {
    super({
      fill: geometry.type === "Polygon" || geometry.type === "MultiPolygon" ? "#2563eb" : "none",
      ...options
    });
    this.geometry = geometry;
    this.convert = convert;
  }

  getBounds(): LatLngBounds {
    const result = new LatLngBounds();
    this.#walkPositions(this.geometry.coordinates, (coordinates) => result.extend(this.convert(coordinates)));
    return result;
  }

  override render(): void {
    super.render();
    if (!this.map || !this.path) return;
    this.path.setAttribute("fill-rule", "evenodd");
    this.path.setAttribute("d", this.#geometryPath());
  }

  #geometryPath(): string {
    const projectRing = (coordinates: GeoJSONPosition[]) =>
      coordinates.map((coordinate) => this.map!.latLngToLayerPoint(this.convert(coordinate)));
    const pathFor = (projected: Array<{ x: number; y: number }>, close = false): string =>
      projectedPointsToPath(simplifyProjectedPoints(projected, this.options.smoothFactor), close);
    const clipped = (projected: Array<{ x: number; y: number }>): boolean =>
      !this.options.noClip && !projectedBoundsIntersectsViewport(this.map!, projectedBounds(projected), this.options.clipPadding);

    if (this.geometry.type === "LineString") {
      const projected = projectRing(this.geometry.coordinates);
      return clipped(projected) ? "" : pathFor(projected);
    }
    if (this.geometry.type === "MultiLineString") {
      return this.geometry.coordinates.map((part) => {
        const projected = projectRing(part);
        return clipped(projected) ? "" : pathFor(projected);
      }).join("");
    }
    if (this.geometry.type === "Polygon") {
      const rings = this.geometry.coordinates.map(projectRing);
      if (clipped(rings.flat())) return "";
      return rings.map((ring) => pathFor(ring, true)).join("");
    }
    return this.geometry.coordinates.map((polygon) => {
      const rings = polygon.map(projectRing);
      if (clipped(rings.flat())) return "";
      return rings.map((ring) => pathFor(ring, true)).join("");
    }).join("");
  }

  #walkPositions(value: unknown, callback: (coordinates: GeoJSONPosition) => void): void {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      callback(value as GeoJSONPosition);
      return;
    }
    for (const child of value) this.#walkPositions(child, callback);
  }
}

export class GeoJSONLayer extends FeatureGroup {
  static coordsToLatLng = geoJSONCoordsToLatLng;
  static latLngToCoords = latLngToGeoJSONCoords;
  static asFeature = geoJSONAsFeature;

  readonly geoJSONOptions: GeoJSONOptions;
  readonly featureEntries: FeatureEntry[] = [];
  readonly defaultStyles = new Map<Layer, PathOptions>();
  readonly rendererMode: "svg" | "canvas" | "webgl";
  private _pathBatch: GeoJSONPathBatch | null = null;
  private _featureCount = 0;
  private _pathBatchFeatureCount = 0;

  constructor(data?: GeoJSONData | null, options: GeoJSONOptions = {}) {
    super();
    this.geoJSONOptions = options;
    const requested = options.renderer ?? "auto";
    const threshold = options.canvasThreshold ?? 250;
    const large = countPathFeatures(data) >= threshold;
    if (requested === "svg" || (requested === "auto" && !large)) {
      this.rendererMode = "svg";
    } else if (requested === "webgl" || (requested === "auto" && large)) {
      // Advanced registers a WebGL batch factory; Standard falls back to canvas.
      this.rendererMode = webglBatchFactory ? "webgl" : "canvas";
    } else {
      this.rendererMode = "canvas";
    }
    if (data) this.addData(data);
  }

  get data(): GeoJSONFeatureCollection {
    return this.toGeoJSON();
  }

  get paths(): Array<{ path: SVGPathElement; geometry: GeoJSONGeometry }> {
    const result: Array<{ path: SVGPathElement; geometry: GeoJSONGeometry }> = [];
    const collect = (layer: Layer): void => {
      if (layer instanceof GeoJSONPathLayer && layer.path) result.push({ path: layer.path, geometry: layer.geometry });
      if (layer instanceof FeatureGroup) layer.eachLayer(collect);
    };
    this.eachLayer(collect);
    return result;
  }

  addData(data: GeoJSONData): this {
    const cap = this.geoJSONOptions.maxFeatures;
    if (cap != null && this._featureCount >= cap) return this;
    if (Array.isArray(data)) {
      for (const item of data) this.addData(item);
      return this;
    }
    if (data.type === "FeatureCollection") {
      for (const feature of data.features) this.addData(feature);
      return this;
    }
    const feature = geoJSONAsFeature(data);
    if (!feature.geometry || (this.geoJSONOptions.filter && !this.geoJSONOptions.filter(feature))) return this;
    const layer = this.#geometryToLayer(feature.geometry, feature);
    if (!layer) return this;
    const batch = isPathBatch(layer);
    if (batch) this._pathBatchFeatureCount++;
    const retain = !batch || this.geoJSONOptions.retainFeatures !== false;
    if (retain) {
      (layer as FeatureLayer).feature = feature;
      this.featureEntries.push({ feature, layer });
    }
    this._featureCount++;
    if (this.geoJSONOptions.popup !== undefined && !isPathBatch(layer)) {
      const configured = this.geoJSONOptions.popup;
      const content: OverlayContent = typeof configured === "function"
        ? (context) => (configured as GeoJSONPopupFactory)(feature, layer, context)
        : configured;
      layer.bindPopup(content, this.geoJSONOptions.popupOptions);
    }
    this.geoJSONOptions.onEachFeature?.(feature, layer);
    if (!batch || !this.hasLayer(layer)) {
      this.addLayer(layer);
    }
    return this;
  }

  /**
   * Responsively ingest parsed GeoJSON, an async stream of GeoJSON chunks, or
   * raw JSON text/Blob. Raw input is parsed in a worker when available; parsed
   * object graphs stay on the main thread and yield cooperatively to avoid a
   * second full structured clone.
   */
  async addDataAsync(input: GeoJSONAsyncInput, options: GeoJSONAsyncOptions = {}): Promise<this> {
    const batch = resolveAsyncBatchOptions(options, 5_000);
    const resolved: ResolvedGeoJSONAsyncOptions = {
      ...batch,
      useWorker: options.useWorker !== false,
      maxBytes: Math.max(0, Number(options.maxBytes) || DEFAULT_ASYNC_GEOJSON_BYTES)
    };
    throwIfAsyncAborted(resolved.signal);

    if (isAsyncIterable<GeoJSONData>(input)) {
      let processed = 0;
      for await (const chunk of input) {
        throwIfAsyncAborted(resolved.signal);
        processed += await this.#addDataCooperatively(chunk, resolved, processed, null);
      }
      return this;
    }

    if (typeof input === "string" || isBlob(input)) {
      const blob = typeof input === "string"
        ? new Blob([input], { type: "application/geo+json" })
        : input;
      if (blob.size > resolved.maxBytes) {
        throw new RangeError(`GeoJSON input exceeds maxBytes (${blob.size} > ${resolved.maxBytes})`);
      }
      const workerTask = resolved.useWorker ? this.#addRawDataInWorker(blob, resolved) : null;
      if (workerTask) {
        try {
          return await workerTask;
        } catch (error) {
          if ((error as Error)?.name !== "NotSupportedError") throw error;
        }
      }
      const text = await blob.text();
      throwIfAsyncAborted(resolved.signal);
      const parsed = JSON.parse(text) as GeoJSONData;
      await this.#addDataCooperatively(parsed, resolved, 0, topLevelGeoJSONCount(parsed));
      return this;
    }

    await this.#addDataCooperatively(input, resolved, 0, topLevelGeoJSONCount(input));
    return this;
  }

  override removeLayer(layer: Layer): this {
    let removed = 0;
    for (let i = this.featureEntries.length - 1; i >= 0; i--) {
      if (this.featureEntries[i].layer !== layer) continue;
      this.featureEntries.splice(i, 1);
      removed++;
    }
    const removedCount = layer === this._pathBatch ? this._pathBatchFeatureCount : removed;
    this._featureCount = Math.max(0, this._featureCount - removedCount);
    if (layer === this._pathBatch) this._pathBatchFeatureCount = 0;
    this.defaultStyles.delete(layer);
    if (layer === this._pathBatch) this._pathBatch = null;
    return super.removeLayer(layer);
  }

  override clearLayers(): this {
    this.featureEntries.length = 0;
    this._featureCount = 0;
    this._pathBatchFeatureCount = 0;
    this.defaultStyles.clear();
    this._pathBatch?.clearPaths();
    this._pathBatch = null;
    return super.clearLayers();
  }

  setStyle(style: PathOptions | GeoJSONStyleFunction): this {
    for (const entry of this.featureEntries) {
      const resolved = typeof style === "function" ? style(entry.feature) : style;
      this.#applyStyle(entry.layer, resolved);
    }
    this._pathBatch?.render();
    return this;
  }

  resetStyle(layer?: Layer): this {
    if (layer) {
      const entry = this.featureEntries.find((candidate) => candidate.layer === layer);
      if (entry) this.#applyStyle(layer, this.#featureStyle(entry.feature));
      return this;
    }
    for (const entry of this.featureEntries) this.#applyStyle(entry.layer, this.#featureStyle(entry.feature));
    this._pathBatch?.render();
    return this;
  }

  toGeoJSON(precision = 6): GeoJSONFeatureCollection {
    return {
      type: "FeatureCollection",
      features: this.featureEntries.map(({ feature, layer }) => {
        const clone = this.#cloneFeature(feature);
        if (clone.geometry?.type === "Point" && "getLatLng" in layer) {
          const getLatLng = (layer as unknown as { getLatLng(): LatLngLike }).getLatLng;
          clone.geometry.coordinates = latLngToGeoJSONCoords(getLatLng.call(layer), precision);
        }
        if (clone.geometry?.type === "MultiPoint" && layer instanceof FeatureGroup) {
          clone.geometry.coordinates = layer.getLayers()
            .filter((child): child is Layer & { getLatLng(): LatLngLike } => "getLatLng" in child)
            .map((child) => latLngToGeoJSONCoords(child.getLatLng(), precision));
        }
        return clone;
      })
    };
  }

  #geometryToLayer(geometry: GeoJSONGeometry, feature: GeoJSONFeature): Layer | null {
    const convert = (coordinates: GeoJSONPosition): LatLng => latLng(
      this.geoJSONOptions.coordsToLatLng?.(coordinates) ?? geoJSONCoordsToLatLng(coordinates)
    );
    if (geometry.type === "Point") return this.#pointLayer(feature, convert(geometry.coordinates));
    if (geometry.type === "MultiPoint") {
      return new FeatureGroup(geometry.coordinates.map((coordinates) => this.#pointLayer(feature, convert(coordinates))));
    }
    if (geometry.type === "GeometryCollection") {
      return new FeatureGroup(
        geometry.geometries.map((child) => this.#geometryToLayer(child, feature)).filter((layer): layer is Layer => Boolean(layer))
      );
    }
    const style = this.#featureStyle(feature);
    if (this.rendererMode === "canvas" || this.rendererMode === "webgl") {
      return this.#addBatchPath(geometry, style, convert, feature);
    }
    const layer = new GeoJSONPathLayer(geometry, style, convert);
    this.defaultStyles.set(layer, style);
    return layer;
  }

  #addBatchPath(
    geometry: PathGeometry,
    style: PathOptions,
    convert: (coordinates: GeoJSONPosition) => LatLng,
    feature: GeoJSONFeature
  ): GeoJSONPathBatch {
    if (!this._pathBatch) {
      const common = {
        interactive: this.geoJSONOptions.interactive !== false,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        strokeOpacity: style.strokeOpacity,
        fill: style.fill,
        fillOpacity: style.fillOpacity,
        lineCap: style.lineCap,
        lineJoin: style.lineJoin,
        pane: this.geoJSONOptions.pane
      };
      this._pathBatch =
        this.rendererMode === "webgl" && webglBatchFactory
          ? webglBatchFactory(common)
          : new CanvasPathBatch(common);
      const configured = this.geoJSONOptions.popup;
      if (configured !== undefined && this.rendererMode === "canvas") {
        const batch = this._pathBatch;
        const content: OverlayContent = typeof configured === "function"
          ? (context) => {
            const feature = (context.event as unknown as { feature?: GeoJSONFeature } | undefined)?.feature;
            return feature ? (configured as GeoJSONPopupFactory)(feature, batch, context) : null;
          }
          : configured;
        batch.bindPopup(content, this.geoJSONOptions.popupOptions);
      }
    }
    if (geometry.type === "LineString") {
      this._pathBatch.addPath([geometry.coordinates.map(convert)], false, style, feature);
    } else if (geometry.type === "MultiLineString") {
      for (const part of geometry.coordinates) {
        this._pathBatch.addPath([part.map(convert)], false, style, feature);
      }
    } else if (geometry.type === "Polygon") {
      this._pathBatch.addPath(
        geometry.coordinates.map((ring) => ring.map(convert)),
        true,
        { fill: style.fill ?? "#2563eb", ...style },
        feature
      );
    } else {
      for (const polygon of geometry.coordinates) {
        this._pathBatch.addPath(
          polygon.map((ring) => ring.map(convert)),
          true,
          { fill: style.fill ?? "#2563eb", ...style },
          feature
        );
      }
    }
    return this._pathBatch;
  }

  #pointLayer(feature: GeoJSONFeature, position: LatLng): Layer {
    return this.geoJSONOptions.pointToLayer?.(feature, position) ?? new Marker(position);
  }

  #featureStyle(feature: GeoJSONFeature): PathOptions {
    const baseStyle: PathOptions = {};
    for (const [key, value] of Object.entries(this.geoJSONOptions)) {
      if (!SPECIAL_OPTION_KEYS.has(key)) (baseStyle as Record<string, unknown>)[key] = value;
    }
    const custom = this.geoJSONOptions.style;
    return { ...baseStyle, ...(typeof custom === "function" ? custom(feature) : custom) };
  }

  #applyStyle(layer: Layer, style: PathOptions): void {
    if (layer instanceof PathLayer) layer.setStyle(style);
    if (layer instanceof FeatureGroup) layer.eachLayer((child) => this.#applyStyle(child, style));
  }

  #cloneFeature(feature: GeoJSONFeature): GeoJSONFeature {
    if (typeof structuredClone === "function") return structuredClone(feature);
    return JSON.parse(JSON.stringify(feature)) as GeoJSONFeature;
  }

  async #addDataCooperatively(
    data: GeoJSONData,
    options: ResolvedGeoJSONAsyncOptions,
    progressOffset: number,
    total: number | null
  ): Promise<number> {
    let processed = 0;
    for (const item of iterateGeoJSONItems(data)) {
      throwIfAsyncAborted(options.signal);
      this.addData(item);
      processed++;
      if (processed % options.chunkSize !== 0) continue;
      options.onProgress?.(progressOffset + processed, total == null ? null : progressOffset + total);
      if (total == null || processed < total) await yieldAsyncBatch(options.yieldMode);
    }
    options.onProgress?.(progressOffset + processed, total == null ? null : progressOffset + total);
    if (total == null && processed > 0 && processed % options.chunkSize !== 0) {
      await yieldAsyncBatch(options.yieldMode);
    }
    throwIfAsyncAborted(options.signal);
    return processed;
  }

  #addRawDataInWorker(
    blob: Blob,
    options: ResolvedGeoJSONAsyncOptions
  ): Promise<this> | null {
    if (typeof Worker === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return null;
    }
    let workerUrl = "";
    let worker: Worker;
    try {
      workerUrl = URL.createObjectURL(new Blob([GEOJSON_PARSE_WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
    } catch {
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      return null;
    }

    return new Promise<this>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onAbort = () => finish(() => reject(asyncAbortError()));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      worker.onerror = (event) => {
        event.preventDefault();
        const error = new Error(event.message || "GeoJSON worker failed");
        error.name = "NotSupportedError";
        finish(() => reject(error));
      };
      worker.onmessage = async (event) => {
        if (settled) return;
        const message = event.data as [GeoJSONData[] | null, number | string, number, boolean];
        if (!Array.isArray(message) || message[0] === null) {
          finish(() => reject(new SyntaxError(String(message?.[1] || "Invalid GeoJSON"))));
          return;
        }
        try {
          throwIfAsyncAborted(options.signal);
          for (const item of message[0]) this.addData(item);
          options.onProgress?.(Number(message[1]) || 0, Number(message[2]) || 0);
          if (message[3]) {
            finish(() => resolve(this));
          } else {
            await yieldAsyncBatch(options.yieldMode);
            throwIfAsyncAborted(options.signal);
            worker.postMessage(0);
          }
        } catch (error) {
          finish(() => reject(error));
        }
      };
      worker.postMessage([blob, options.chunkSize]);
    });
  }
}

export function geoJSON(data?: GeoJSONData | null, options?: GeoJSONOptions): GeoJSONLayer {
  return new GeoJSONLayer(data, options);
}
