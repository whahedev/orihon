import {
  LatLngBounds,
  Layer,
  geoJSON,
  marker,
  polygon,
  polyline,
  tileLayer,
  type LatLngBoundsLike,
  type MarkerOptions,
  type Orihon,
  type RasterTileLayer
} from "../standard.js";
import { AIError, toAIError } from "./errors.js";
import type {
  AIBasemapSpec,
  AICommand,
  AICommandSuccess,
  AILayerDescription,
  AILayerSpec,
  AIPosition,
  AIResult,
  AISceneSpec
} from "./types.js";
import { validateCommand, validateLayer, validateScene } from "./validation.js";

interface LayerRecord {
  spec: AILayerSpec;
  layer: Layer;
}

interface OverlayLayer extends Layer {
  bindPopup(content: string): unknown;
  bindTooltip(content: string): unknown;
}

interface EasyBasemapMap extends Orihon {
  setBasemap(value: Omit<AIBasemapSpec, "type"> | null): unknown;
}

function hasEasyBasemap(map: Orihon): map is EasyBasemapMap {
  return typeof (map as unknown as Partial<EasyBasemapMap>).setBasemap === "function";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bindText(layer: Layer, spec: AILayerSpec): Layer {
  const overlay = layer as unknown as Partial<OverlayLayer>;
  if (spec.popup && typeof overlay.bindPopup === "function") overlay.bindPopup(spec.popup.text);
  if (spec.tooltip && typeof overlay.bindTooltip === "function") overlay.bindTooltip(spec.tooltip.text);
  return layer;
}

function createLayer(spec: AILayerSpec): Layer {
  if (spec.type === "marker") {
    const options = {
      ...spec.appearance,
      title: spec.title,
      opacity: spec.opacity,
      zIndexOffset: spec.zIndexOffset,
      interactive: spec.interactive,
      rotation: spec.rotation,
      attribution: spec.attribution
    } as MarkerOptions;
    return bindText(marker(spec.position, options), spec);
  }
  if (spec.type === "polyline") {
    return bindText(polyline(spec.coordinates, { ...spec.style, attribution: spec.attribution }), spec);
  }
  if (spec.type === "polygon") {
    return bindText(polygon(spec.rings, { ...spec.style, attribution: spec.attribution }), spec);
  }
  if (spec.type === "geojson") {
    return bindText(geoJSON(spec.data, {
      ...spec.style,
      style: spec.style,
      renderer: spec.renderer,
      maxFeatures: spec.maxFeatures,
      attribution: spec.attribution
    }), spec);
  }
  const { id: _id, type: _type, popup: _popup, tooltip: _tooltip, url, ...options } = spec;
  return tileLayer(url, { ...options, renderer: "dom" });
}

function createBasemap(spec: AIBasemapSpec): RasterTileLayer {
  const { type: _type, url, ...options } = spec;
  return tileLayer(url, { ...options, renderer: "dom" });
}

function deepMerge(target: unknown, patch: unknown): unknown {
  if (!target || typeof target !== "object" || Array.isArray(target)
    || !patch || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const result = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] = key in result ? deepMerge(result[key], value) : clone(value);
  }
  return result;
}

function extendLayerBounds(target: LatLngBounds, record: LayerRecord): void {
  const { spec, layer } = record;
  if (spec.type === "marker") {
    target.extend(spec.position);
    return;
  }
  if (spec.type === "polyline") {
    for (const coordinate of spec.coordinates) target.extend(coordinate);
    return;
  }
  if (spec.type === "polygon") {
    const rings: AIPosition[][] = Array.isArray(spec.rings[0])
      ? spec.rings as AIPosition[][]
      : [spec.rings as AIPosition[]];
    for (const ring of rings) for (const coordinate of ring) target.extend(coordinate);
    return;
  }
  const bounded = layer as Layer & { getBounds?: () => LatLngBoundsLike };
  if (typeof bounded.getBounds === "function") target.extend(bounded.getBounds());
}

/** Stateful executor for validated, JSON-only AI commands. */
export class AISession {
  readonly map: Orihon;
  readonly #layers = new Map<string, LayerRecord>();
  #basemap: AIBasemapSpec | null | undefined;
  #basemapLayer: RasterTileLayer | null = null;

  constructor(map: Orihon) {
    if (!map || typeof map.addLayer !== "function" || typeof map.setView !== "function") {
      throw new TypeError("createAISession(map) requires an Orihon map");
    }
    this.map = map;
  }

  /** Execute an untrusted tool-call payload without throwing validation errors. */
  execute(input: unknown): AIResult<AICommandSuccess> {
    try {
      const command = validateCommand(input);
      return { ok: true, value: this.#execute(command) };
    } catch (error) {
      return { ok: false, error: toAIError(error).toJSON() };
    }
  }

  /** Replace the session-owned scene after validating the entire payload. */
  applyScene(input: unknown): AIResult<AICommandSuccess> {
    try {
      const scene = validateScene(input);
      return { ok: true, value: this.#applyScene(scene) };
    } catch (error) {
      return { ok: false, error: toAIError(error).toJSON() };
    }
  }

  /** JSON snapshot of the session-owned layers and current map camera. */
  query(ids?: readonly string[]): AISceneSpec {
    const selected = this.#select(ids);
    const center = this.map.getCenter();
    return clone({
      version: 1,
      camera: { center: { lat: center.lat, lng: center.lng }, zoom: this.map.getZoom() },
      ...(this.#basemap === undefined ? {} : { basemap: this.#basemap }),
      layers: selected.map(({ spec }) => spec)
    });
  }

  #select(ids?: readonly string[]): LayerRecord[] {
    if (ids === undefined) return [...this.#layers.values()];
    return ids.map((id) => {
      const record = this.#layers.get(id);
      if (!record) throw new AIError("NOT_FOUND", "$command.ids", `No AI layer has ID "${id}"`, id);
      return record;
    });
  }

  #add(spec: AILayerSpec): void {
    if (this.#layers.has(spec.id)) throw new AIError("DUPLICATE_ID", "$command.id", `AI layer "${spec.id}" already exists`, spec.id);
    const layer = createLayer(spec);
    this.map.addLayer(layer);
    this.#layers.set(spec.id, { spec: clone(spec), layer });
  }

  #remove(id: string): void {
    const record = this.#layers.get(id);
    if (!record) throw new AIError("NOT_FOUND", "$command.id", `No AI layer has ID "${id}"`, id);
    if (this.map.hasLayer(record.layer)) this.map.removeLayer(record.layer);
    this.#layers.delete(id);
  }

  #clear(ids?: readonly string[]): string[] {
    const selected = ids === undefined ? [...this.#layers.keys()] : [...ids];
    if (ids !== undefined) this.#select(ids);
    for (const id of selected) this.#remove(id);
    return selected;
  }

  #update(id: string, patch: Record<string, unknown>): void {
    const current = this.#layers.get(id);
    if (!current) throw new AIError("NOT_FOUND", "$command.id", `No AI layer has ID "${id}"`, id);
    const next = validateLayer(deepMerge(current.spec, patch), "$command.patch") as AILayerSpec;
    const nextLayer = createLayer(next);
    this.map.addLayer(nextLayer);
    if (this.map.hasLayer(current.layer)) this.map.removeLayer(current.layer);
    this.#layers.set(id, { spec: clone(next), layer: nextLayer });
  }

  #fit(ids: readonly string[] | undefined, padding: number, animation: "none" | "fly", durationMs?: number): void {
    const selected = this.#select(ids);
    const area = new LatLngBounds();
    for (const record of selected) extendLayerBounds(area, record);
    if (!area.isValid()) throw new AIError("EMPTY_SELECTION", "$command.ids", "Selected layers do not have geographic bounds", ids);
    if (animation === "fly") this.map.flyToBounds(area, { padding, durationMs });
    else this.map.fitBounds(area, { padding });
  }

  #setBasemap(spec: AIBasemapSpec | null): void {
    const ownedEasyBasemap = this.#basemap !== undefined && this.#basemap !== null;
    this.#basemapLayer?.remove();
    this.#basemapLayer = null;
    if (hasEasyBasemap(this.map)) {
      if (spec) {
        const { type: _type, ...options } = spec;
        this.map.setBasemap(options);
      } else if (ownedEasyBasemap) {
        this.map.setBasemap(null);
      }
    } else if (spec) {
      this.#basemapLayer = createBasemap(spec).addTo(this.map);
    }
    this.#basemap = spec === null ? null : clone(spec);
  }

  #applyScene(scene: AISceneSpec): AICommandSuccess {
    const prepared = scene.layers.map((spec) => ({ spec: clone(spec), layer: createLayer(spec) }));
    const previous = [...this.#layers.entries()];
    for (const [, record] of previous) if (this.map.hasLayer(record.layer)) this.map.removeLayer(record.layer);
    this.#layers.clear();
    try {
      for (const record of prepared) {
        this.map.addLayer(record.layer);
        this.#layers.set(record.spec.id, record);
      }
    } catch (error) {
      for (const record of this.#layers.values()) if (this.map.hasLayer(record.layer)) this.map.removeLayer(record.layer);
      this.#layers.clear();
      for (const [id, record] of previous) {
        this.map.addLayer(record.layer);
        this.#layers.set(id, record);
      }
      throw error;
    }
    if (scene.basemap !== undefined) this.#setBasemap(scene.basemap);
    if (scene.camera) this.map.setView(scene.camera.center, scene.camera.zoom);
    return { op: "apply_scene", ids: scene.layers.map(({ id }) => id), scene: this.query() };
  }

  #execute(command: AICommand): AICommandSuccess {
    if (command.op === "set_view") {
      this.map.setView(command.center, command.zoom);
      return { op: command.op };
    }
    if (command.op === "fly_to") {
      this.map.flyTo(command.center, command.zoom ?? this.map.getZoom(), { durationMs: command.durationMs });
      return { op: command.op };
    }
    if (command.op === "add") {
      this.#add({ id: command.id, ...command.layer } as AILayerSpec);
      return { op: command.op, ids: [command.id] };
    }
    if (command.op === "update") {
      this.#update(command.id, command.patch);
      return { op: command.op, ids: [command.id] };
    }
    if (command.op === "remove") {
      this.#remove(command.id);
      return { op: command.op, ids: [command.id] };
    }
    if (command.op === "clear") return { op: command.op, ids: this.#clear(command.ids) };
    if (command.op === "fit") {
      this.#fit(command.ids, command.padding ?? 32, command.animation ?? "none", command.durationMs);
      return { op: command.op, ids: command.ids ? [...command.ids] : [...this.#layers.keys()] };
    }
    if (command.op === "query") return { op: command.op, scene: this.query(command.ids) };
    return this.#applyScene(command.scene);
  }
}

export function createAISession(map: Orihon): AISession {
  return new AISession(map);
}

/** One-shot scene application. Use createAISession() when later updates are required. */
export function applyScene(map: Orihon, scene: unknown): AIResult<AICommandSuccess> {
  return createAISession(map).applyScene(scene);
}
