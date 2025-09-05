import { LatLngBounds, latLngBounds, type LatLngBoundsLike, type LatLngLike } from "./geo.js";
import { Layer, type LayerOptions } from "./layer.js";
import type { Orihon } from "./map.js";

export class LayerGroup extends Layer {
  protected readonly groupLayers = new Set<Layer>();

  constructor(layers: Iterable<Layer> = [], options: LayerOptions = {}) {
    super(options);
    for (const layer of layers) this.addLayer(layer);
  }

  addLayer(layer: Layer): this {
    if (this.groupLayers.has(layer)) return this;
    this.groupLayers.add(layer);
    if (this.map) this.map.addLayer(layer);
    return this;
  }

  removeLayer(layer: Layer): this {
    if (!this.groupLayers.delete(layer)) return this;
    if (this.map?.hasLayer(layer)) this.map.removeLayer(layer);
    return this;
  }

  hasLayer(layer: Layer): boolean {
    return this.groupLayers.has(layer);
  }

  clearLayers(): this {
    for (const layer of [...this.groupLayers]) this.removeLayer(layer);
    return this;
  }

  eachLayer(callback: (layer: Layer) => void, context?: unknown): this {
    for (const layer of [...this.groupLayers]) callback.call(context, layer);
    return this;
  }

  invoke(methodName: string, ...args: unknown[]): this {
    for (const layer of this.groupLayers) {
      const method = (layer as unknown as Record<string, unknown>)[methodName];
      if (typeof method === "function") method.apply(layer, args);
    }
    return this;
  }

  getLayers(): Layer[] {
    return [...this.groupLayers];
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    for (const layer of this.groupLayers) map.addLayer(layer);
  }

  override onRemove(): void {
    const map = this.map;
    if (map) for (const layer of this.groupLayers) map.removeLayer(layer);
    super.onRemove();
  }
}

interface BoundedLayer extends Layer {
  getBounds(): LatLngBoundsLike;
}

interface LocatedLayer extends Layer {
  getLatLng(): LatLngLike;
}

function hasBounds(layer: Layer): layer is BoundedLayer {
  return typeof (layer as unknown as Partial<BoundedLayer>).getBounds === "function";
}

function hasLatLng(layer: Layer): layer is LocatedLayer {
  return typeof (layer as unknown as Partial<LocatedLayer>).getLatLng === "function";
}

export class FeatureGroup extends LayerGroup {
  constructor(layers: Iterable<Layer> = [], options: LayerOptions = {}) {
    super([], options);
    for (const layer of layers) this.addLayer(layer);
  }

  override addLayer(layer: Layer): this {
    if (this.hasLayer(layer)) return this;
    layer.addEventParent(this);
    return super.addLayer(layer);
  }

  override removeLayer(layer: Layer): this {
    if (!this.hasLayer(layer)) return this;
    layer.removeEventParent(this);
    return super.removeLayer(layer);
  }

  override clearLayers(): this {
    return super.clearLayers();
  }

  getBounds(): LatLngBounds {
    const result = latLngBounds();
    for (const layer of this.groupLayers) {
      if (hasBounds(layer)) result.extend(layer.getBounds());
      else if (hasLatLng(layer)) result.extend(layer.getLatLng());
    }
    return result;
  }

  setStyle(style: Record<string, unknown>): this {
    return this.invoke("setStyle", style);
  }
}

export function layerGroup(layers: Iterable<Layer> = [], options?: LayerOptions): LayerGroup {
  return new LayerGroup(layers, options);
}

export function featureGroup(layers: Iterable<Layer> = [], options?: LayerOptions): FeatureGroup {
  return new FeatureGroup(layers, options);
}
