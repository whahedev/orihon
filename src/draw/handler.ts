import { Evented, type OrihonEvent } from "../events.js";
import { destination, latLng, type LatLngLike, type PointLike } from "../geo.js";
import { FeatureGroup, featureGroup } from "../layer-group.js";
import type { Layer } from "../layer.js";
import { Marker, marker } from "../layers/marker.js";
import { Circle, Polygon, Polyline, circle, polygon, polyline, rectangle, type PathOptions } from "../layers/vector.js";
import type { GeoJSONData, GeoJSONFeature, GeoJSONFeatureCollection, GeoJSONGeometry } from "../layers/geojson.js";
import type { Orihon } from "../map.js";
import { drawHandle, midpoint, type DrawHandle } from "./handles.js";
import { snapLatLng, type DrawSnapOptions } from "./snap.js";

export type DrawMode = "off" | "point" | "polyline" | "polygon" | "rectangle" | "circle" | "edit" | "delete";

export interface DrawHandlerOptions {
  modes?: DrawMode[];
  snap?: DrawSnapOptions;
  snapLayers?: Layer[];
  guide?: PathOptions;
  featureGroup?: FeatureGroup;
  capturePointer?: boolean;
}

type MutableLayer = Marker | Polyline | Polygon | Circle;

export class DrawHandler extends Evented {
  readonly options: Required<Omit<DrawHandlerOptions, "featureGroup" | "snapLayers">> & {
    featureGroup: FeatureGroup;
    snapLayers: Layer[];
  };
  readonly featureGroup: FeatureGroup;
  map: Orihon | null = null;
  mode: DrawMode = "off";
  private vertices: ReturnType<typeof latLng>[] = [];
  private guideLayer: Polyline | Polygon | null = null;
  private handles: DrawHandle[] = [];
  private editingLayer: MutableLayer | null = null;
  private snapshots: GeoJSONFeatureCollection[] = [];
  private snapshotIndex = -1;
  private unsubs: Array<() => void> = [];
  private behaviors = new Map<"dblClick" | "boxZoom", boolean>();
  private dragStart: ReturnType<typeof latLng> | null = null;
  private dragPoint: ReturnType<typeof latLng> | null = null;
  private addedGroup = false;

  constructor(options: DrawHandlerOptions = {}) {
    super();
    this.featureGroup = options.featureGroup ?? featureGroup();
    this.options = {
      modes: options.modes ?? ["point", "polyline", "polygon", "rectangle", "circle", "edit", "delete"],
      snap: { enabled: true, pixelTolerance: 12, grid: false, ...options.snap },
      snapLayers: options.snapLayers ?? [],
      guide: { stroke: "#0f766e", strokeWidth: 2, dashArray: "6 4", fillOpacity: 0.08, ...options.guide },
      featureGroup: this.featureGroup,
      capturePointer: options.capturePointer !== false
    };
    this.#resetHistory();
  }

  addTo(map: Orihon): this {
    if (this.map === map) return this;
    this.remove();
    this.map = map;
    this.addedGroup = !map.hasLayer(this.featureGroup);
    if (this.addedGroup) this.featureGroup.addTo(map);
    const click = (event: OrihonEvent): void => this.#mapClick(event);
    const move = (event: PointerEvent): void => this.#pointerMove(event);
    const down = (event: PointerEvent): void => this.#pointerDown(event);
    const up = (event: PointerEvent): void => this.#pointerUp(event);
    const key = (event: KeyboardEvent): void => this.#keyDown(event);
    const doubleClick = (event: MouseEvent): void => {
      if (this.mode !== "polyline" && this.mode !== "polygon") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.finish();
    };
    const deletion = (event: OrihonEvent): void => this.#featureClick(event);
    map.on("click", click);
    this.featureGroup.on("click", deletion);
    map.container.addEventListener("pointermove", move, true);
    map.container.addEventListener("pointerdown", down, true);
    map.container.addEventListener("pointerup", up, true);
    map.container.addEventListener("pointercancel", up, true);
    map.container.addEventListener("dblclick", doubleClick, true);
    if (typeof window !== "undefined") window.addEventListener("keydown", key);
    else map.container.addEventListener("keydown", key);
    if (map.container.tabIndex < 0) map.container.tabIndex = 0;
    this.unsubs.push(
      () => map.off("click", click),
      () => this.featureGroup.off("click", deletion),
      () => map.container.removeEventListener("pointermove", move, true),
      () => map.container.removeEventListener("pointerdown", down, true),
      () => map.container.removeEventListener("pointerup", up, true),
      () => map.container.removeEventListener("pointercancel", up, true),
      () => map.container.removeEventListener("dblclick", doubleClick, true),
      () => {
        if (typeof window !== "undefined") window.removeEventListener("keydown", key);
        else map.container.removeEventListener("keydown", key);
      }
    );
    this.#resetHistory();
    return this;
  }

  remove(options: { destroyFeatures?: boolean } = {}): this {
    this.setMode("off");
    for (const unsubscribe of this.unsubs.splice(0)) unsubscribe();
    this.#clearHandles();
    this.#clearGuide();
    if (options.destroyFeatures) this.featureGroup.clearLayers();
    if (this.addedGroup) this.featureGroup.remove();
    this.addedGroup = false;
    this.map = null;
    return this;
  }

  setMode(mode: DrawMode): this {
    if (mode !== "off" && !this.options.modes.includes(mode)) throw new TypeError(`Draw mode is not enabled: ${mode}`);
    if (this.mode === mode) return this;
    const previous = this.mode;
    this.#cancelShape();
    this.#clearHandles();
    this.editingLayer = null;
    this.mode = mode;
    this.#syncBehaviors();
    if (mode === "edit") this.emit("editstart");
    if (mode === "delete") this.emit("deletestart");
    this.emit("modechange", { mode, previous });
    return this;
  }

  finish(): this {
    if (this.mode !== "polyline" && this.mode !== "polygon") return this;
    const minimum = this.mode === "polygon" ? 3 : 2;
    if (this.vertices.length < minimum) return this;
    const layer = this.mode === "polygon"
      ? polygon(this.vertices, this.options.guide)
      : polyline(this.vertices, this.options.guide);
    this.#complete(layer);
    return this;
  }

  cancel(): this {
    this.#cancelShape();
    return this;
  }

  undo(): this {
    if (this.snapshotIndex <= 0) return this;
    this.snapshotIndex--;
    this.#restore(this.snapshots[this.snapshotIndex]);
    this.emit("undo", { geojson: this.toGeoJSON() });
    return this;
  }

  redo(): this {
    if (this.snapshotIndex >= this.snapshots.length - 1) return this;
    this.snapshotIndex++;
    this.#restore(this.snapshots[this.snapshotIndex]);
    this.emit("redo", { geojson: this.toGeoJSON() });
    return this;
  }

  toGeoJSON(): GeoJSONFeatureCollection {
    return { type: "FeatureCollection", features: this.featureGroup.getLayers().flatMap((layer) => this.#layerFeatures(layer)) };
  }

  loadData(data: GeoJSONData): this {
    this.featureGroup.clearLayers();
    const features = this.#asFeatures(data);
    for (const feature of features) this.#loadFeature(feature);
    this.#commit();
    return this;
  }

  #mapClick(event: OrihonEvent): void {
    if (!this.map || !["point", "polyline", "polygon"].includes(this.mode)) return;
    const value = this.#snap(event.latlng as LatLngLike);
    if (this.mode === "point") {
      this.emit("drawstart", { mode: this.mode, latlng: value });
      this.#complete(marker(value));
      return;
    }
    if (!this.vertices.length) this.emit("drawstart", { mode: this.mode, latlng: value });
    this.vertices.push(value);
    this.#updateGuide(value);
    this.emit("drawvertex", { mode: this.mode, latlng: value, vertices: this.vertices.map((item) => item.clone()) });
  }

  #pointerDown(event: PointerEvent): void {
    if (!this.map || (this.mode !== "rectangle" && this.mode !== "circle") || event.button !== 0) return;
    if ((event.target as Element | null)?.closest?.(".oh-control")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const value = this.#snap(this.#eventLatLng(event));
    this.dragStart = value;
    this.dragPoint = value;
    this.emit("drawstart", { mode: this.mode, latlng: value });
  }

  #pointerMove(event: PointerEvent): void {
    if (!this.map) return;
    const value = this.#snap(this.#eventLatLng(event), false);
    if (this.dragStart && (this.mode === "rectangle" || this.mode === "circle")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.dragPoint = value;
      this.#updateDragGuide();
      return;
    }
    if ((this.mode === "polyline" || this.mode === "polygon") && this.vertices.length) this.#updateGuide(value);
  }

  #pointerUp(event: PointerEvent): void {
    if (!this.map || !this.dragStart || !this.dragPoint) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const start = this.dragStart;
    const end = this.#snap(this.#eventLatLng(event));
    const layer = this.mode === "rectangle"
      ? rectangle([start, end], this.options.guide)
      : circle(start, this.map.distance(start, end), { ...this.options.guide, geodesic: true });
    this.dragStart = this.dragPoint = null;
    this.#complete(layer);
  }

  #keyDown(event: KeyboardEvent): void {
    if (this.mode === "off") return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z" && !event.shiftKey) {
      event.preventDefault();
      this.undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (key === "y" || (key === "z" && event.shiftKey))) {
      event.preventDefault();
      this.redo();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancel();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.finish();
    }
  }

  #featureClick(event: OrihonEvent): void {
    const layer = (event.layer ?? event.sourceTarget) as Layer;
    if (!this.featureGroup.hasLayer(layer)) return;
    if (this.mode === "delete") {
      this.featureGroup.removeLayer(layer);
      this.#commit();
      this.emit("deletecomplete", { layer, geojson: this.toGeoJSON() });
      return;
    }
    if (
      this.mode === "edit"
      && (layer instanceof Marker || layer instanceof Polyline || layer instanceof Polygon || layer instanceof Circle)
    ) {
      this.editingLayer = layer;
      this.#buildHandles(layer);
    }
  }

  #buildHandles(layer: MutableLayer): void {
    this.#clearHandles();
    if (!this.map) return;
    if (layer instanceof Circle) {
      this.#buildCircleHandles(layer);
      return;
    }
    if (layer instanceof Marker) {
      const handle = drawHandle(layer.getLatLng(), "vertex", 0, 0);
      handle.marker.on("drag", (event) => {
        layer.setLatLng(event.latlng as LatLngLike);
        this.emit("editvertex", { layer, latlng: layer.getLatLng() });
      });
      handle.marker.on("dragend", () => this.#finishEdit(layer));
      this.handles.push(handle);
      handle.marker.addTo(this.map);
      return;
    }
    const pathLayer = layer as Polyline | Polygon;
    const rings = pathLayer instanceof Polygon ? pathLayer.getLatLngs() : [pathLayer.getLatLngs() as ReturnType<Polyline["getLatLngs"]> as ReturnType<typeof latLng>[]];
    rings.forEach((ring, ringIndex) => {
      ring.forEach((position, index) => {
        const handle = drawHandle(position, "vertex", ringIndex, index);
        handle.marker.on("drag", (event) => this.#moveVertex(pathLayer, ringIndex, index, event.latlng as LatLngLike));
        handle.marker.on("dragend", () => this.#finishEdit(pathLayer));
        handle.marker.on("click", (event) => {
          if ((event.originalEvent as MouseEvent | undefined)?.altKey) this.#deleteVertex(pathLayer, ringIndex, index);
        });
        this.handles.push(handle);
        handle.marker.addTo(this.map!);
        if (ring.length > 1 && (pathLayer instanceof Polygon || index < ring.length - 1)) {
          const nextIndex = (index + 1) % ring.length;
          const mid = drawHandle(midpoint(position, ring[nextIndex]), "midpoint", ringIndex, nextIndex);
          let inserted = false;
          mid.marker.once("dragstart", () => {
            const next = this.#rings(pathLayer);
            next[ringIndex].splice(nextIndex, 0, mid.marker.getLatLng());
            this.#setRings(pathLayer, next);
            inserted = true;
          });
          mid.marker.on("drag", (event) => {
            if (inserted) this.#moveVertex(pathLayer, ringIndex, nextIndex, event.latlng as LatLngLike);
          });
          mid.marker.on("dragend", () => {
            if (!inserted) return;
            this.#finishEdit(pathLayer);
            this.#buildHandles(pathLayer);
          });
          this.handles.push(mid);
          mid.marker.addTo(this.map!);
        }
      });
    });
  }

  #buildCircleHandles(layer: Circle): void {
    if (!this.map) return;
    const centerHandle = drawHandle(layer.getLatLng(), "vertex", 0, 0);
    centerHandle.marker.on("drag", (event) => {
      const next = this.#snap(event.latlng as LatLngLike);
      layer.setLatLng(next);
      const edge = this.handles[1];
      if (edge) edge.marker.setLatLng(destination(next, layer.getRadius(), 90));
      this.emit("editvertex", { layer, latlng: layer.getLatLng(), role: "center" });
    });
    centerHandle.marker.on("dragend", () => this.#finishEdit(layer));
    this.handles.push(centerHandle);
    centerHandle.marker.addTo(this.map);

    const edgeHandle = drawHandle(destination(layer.getLatLng(), layer.getRadius(), 90), "midpoint", 0, 1);
    edgeHandle.marker.on("drag", (event) => {
      const edge = this.#snap(event.latlng as LatLngLike);
      const radius = Math.max(1, this.map!.distance(layer.getLatLng(), edge));
      layer.setRadius(radius);
      edgeHandle.marker.setLatLng(destination(layer.getLatLng(), radius, 90));
      this.emit("editvertex", { layer, latlng: edge, role: "radius", radius });
    });
    edgeHandle.marker.on("dragend", () => this.#finishEdit(layer));
    this.handles.push(edgeHandle);
    edgeHandle.marker.addTo(this.map);
  }

  #moveVertex(layer: Polyline | Polygon, ring: number, index: number, value: LatLngLike): void {
    const rings = this.#rings(layer);
    rings[ring][index] = this.#snap(value);
    this.#setRings(layer, rings);
    this.emit("editvertex", { layer, ring, index, latlng: rings[ring][index] });
  }

  #deleteVertex(layer: Polyline | Polygon, ring: number, index: number): void {
    const rings = this.#rings(layer);
    const minimum = layer instanceof Polygon ? 3 : 2;
    if (rings[ring].length <= minimum) return;
    rings[ring].splice(index, 1);
    this.#setRings(layer, rings);
    this.#finishEdit(layer);
    this.#buildHandles(layer);
  }

  #finishEdit(layer: MutableLayer): void {
    this.#commit();
    this.emit("editcomplete", { layer, geojson: this.toGeoJSON() });
  }

  #rings(layer: Polyline | Polygon): ReturnType<typeof latLng>[][] {
    return layer instanceof Polygon ? layer.getLatLngs() : [layer.getLatLngs() as ReturnType<typeof latLng>[]];
  }

  #setRings(layer: Polyline | Polygon, rings: ReturnType<typeof latLng>[][]): void {
    if (layer instanceof Polygon) layer.setLatLngs(rings);
    else layer.setLatLngs(rings[0]);
  }

  #complete(layer: Layer): void {
    this.#clearGuide();
    this.vertices = [];
    this.featureGroup.addLayer(layer);
    this.#commit();
    this.emit("drawcomplete", { layer, geojson: this.#layerFeatures(layer)[0] });
  }

  #updateGuide(cursor: ReturnType<typeof latLng>): void {
    if (!this.map) return;
    const points = [...this.vertices, cursor];
    if (!this.guideLayer) {
      this.guideLayer = this.mode === "polygon" ? polygon(points, this.options.guide) : polyline(points, this.options.guide);
      this.guideLayer.addTo(this.map);
    } else this.guideLayer.setLatLngs(points);
  }

  #updateDragGuide(): void {
    if (!this.map || !this.dragStart || !this.dragPoint) return;
    this.#clearGuide();
    this.guideLayer = this.mode === "rectangle"
      ? rectangle([this.dragStart, this.dragPoint], this.options.guide)
      : polygon(Array.from({ length: 32 }, (_, index) => destination(
          this.dragStart!, this.map!.distance(this.dragStart!, this.dragPoint!), index * 360 / 32
        )), this.options.guide);
    this.guideLayer.addTo(this.map);
  }

  #clearGuide(): void {
    this.guideLayer?.remove();
    this.guideLayer = null;
  }

  #cancelShape(): void {
    this.vertices = [];
    this.dragStart = this.dragPoint = null;
    this.#clearGuide();
  }

  #clearHandles(): void {
    for (const handle of this.handles) handle.marker.remove();
    this.handles = [];
  }

  #snap(value: LatLngLike, emit = true): ReturnType<typeof latLng> {
    if (!this.map) return latLng(value);
    const result = snapLatLng(this.map, value, [this.featureGroup, ...this.options.snapLayers], this.options.snap);
    if (emit && result.snapped) this.emit("snap", { latlng: result.latlng, layer: result.layer });
    return result.latlng;
  }

  #eventLatLng(event: PointerEvent): ReturnType<typeof latLng> {
    const rect = this.map!.container.getBoundingClientRect();
    return this.map!.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top]);
  }

  #syncBehaviors(): void {
    if (!this.map || !this.options.capturePointer) return;
    if (this.mode !== "off" && !this.behaviors.size) {
      for (const name of ["dblClick", "boxZoom"] as const) {
        const enabled = this.map.behaviors.isEnabled(name);
        this.behaviors.set(name, enabled);
        if (enabled) this.map.behaviors.disable(name);
      }
    } else if (this.mode === "off" && this.behaviors.size) {
      for (const [name, enabled] of this.behaviors) this.map.behaviors.toggle(name, enabled);
      this.behaviors.clear();
    }
  }

  #commit(): void {
    const snapshot = this.toGeoJSON();
    this.snapshots.splice(this.snapshotIndex + 1);
    this.snapshots.push(snapshot);
    if (this.snapshots.length > 50) this.snapshots.shift();
    this.snapshotIndex = this.snapshots.length - 1;
  }

  #resetHistory(): void {
    this.snapshots = [this.toGeoJSON()];
    this.snapshotIndex = 0;
  }

  #restore(snapshot: GeoJSONFeatureCollection): void {
    this.featureGroup.clearLayers();
    for (const feature of snapshot.features) this.#loadFeature(feature);
    this.#clearHandles();
  }

  #layerFeatures(layer: Layer): GeoJSONFeature[] {
    if (layer instanceof FeatureGroup) return layer.getLayers().flatMap((child) => this.#layerFeatures(child));
    if (layer instanceof Marker) return [this.#feature({ type: "Point", coordinates: this.#coordinate(layer.getLatLng()) })];
    if (layer instanceof Circle) return [this.#feature(
      { type: "Point", coordinates: this.#coordinate(layer.getLatLng()) },
      { radius: layer.getRadius() }
    )];
    if (layer instanceof Polygon) {
      const coordinates = layer.getLatLngs().map((ring) => {
        const values = ring.map((value) => this.#coordinate(value));
        if (values.length && (values[0][0] !== values.at(-1)![0] || values[0][1] !== values.at(-1)![1])) values.push([...values[0]]);
        return values;
      });
      return [this.#feature({ type: "Polygon", coordinates })];
    }
    if (layer instanceof Polyline) {
      return [this.#feature({ type: "LineString", coordinates: (layer.getLatLngs() as ReturnType<typeof latLng>[]).map((value) => this.#coordinate(value)) })];
    }
    return [];
  }

  #feature(geometry: GeoJSONGeometry, properties: Record<string, unknown> = {}): GeoJSONFeature {
    return { type: "Feature", properties, geometry };
  }

  #coordinate(value: LatLngLike): [number, number] {
    const position = latLng(value);
    return [position.lng, position.lat];
  }

  #asFeatures(data: GeoJSONData): GeoJSONFeature[] {
    if (Array.isArray(data)) return data.flatMap((item) => this.#asFeatures(item));
    if (data.type === "FeatureCollection") return data.features;
    if (data.type === "Feature") return [data];
    return [{ type: "Feature", properties: {}, geometry: data }];
  }

  #loadFeature(feature: GeoJSONFeature): void {
    const geometry = feature.geometry;
    if (!geometry) return;
    const convert = (coordinate: number[]): [number, number] => [Number(coordinate[1]), Number(coordinate[0])];
    if (geometry.type === "Point") {
      const position = convert(geometry.coordinates);
      const radius = Number(feature.properties?.radius);
      this.featureGroup.addLayer(Number.isFinite(radius) && radius > 0 ? circle(position, radius, { geodesic: true }) : marker(position));
    } else if (geometry.type === "LineString") {
      this.featureGroup.addLayer(polyline(geometry.coordinates.map(convert)));
    } else if (geometry.type === "Polygon") {
      this.featureGroup.addLayer(polygon(geometry.coordinates.map((ring) => ring.slice(0, -1).map(convert))));
    } else if (geometry.type === "MultiLineString") {
      for (const line of geometry.coordinates) this.featureGroup.addLayer(polyline(line.map(convert)));
    } else if (geometry.type === "MultiPolygon") {
      for (const area of geometry.coordinates) this.featureGroup.addLayer(polygon(area.map((ring) => ring.slice(0, -1).map(convert))));
    } else if (geometry.type === "MultiPoint") {
      for (const position of geometry.coordinates) this.featureGroup.addLayer(marker(convert(position)));
    } else if (geometry.type === "GeometryCollection") {
      for (const child of geometry.geometries) this.#loadFeature({ ...feature, geometry: child });
    }
  }
}
