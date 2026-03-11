import { LayerGroup } from "../layer-group.js";
import { GeoJSONLayer, type GeoJSONFeature, type GeoJSONOptions } from "./geojson.js";
import type { LatLngBoundsLike } from "../geo.js";
import type { Orihon } from "../map.js";
import { circleMarker, type PathOptions } from "./vector.js";
import { forEachTileInRect, forEachTileRectDelta, type TileRect } from "./tile-grid.js";

export interface VectorTileCoordinates {
  x: number;
  y: number;
  z: number;
  bounds: LatLngBoundsLike;
  signal: AbortSignal;
}

export type VectorTileProvider = (
  coordinates: VectorTileCoordinates
) => Promise<GeoJSONFeature[] | null | undefined> | GeoJSONFeature[] | null | undefined;

export interface MVTPaintRule extends PathOptions {
  layer: string;
  type: "fill" | "line" | "circle";
  minZoom?: number;
  maxZoom?: number;
  radius?: number;
  filter?: (feature: GeoJSONFeature) => boolean;
}

export interface VectorTileLayerOptions extends Omit<GeoJSONOptions, "filter" | "style"> {
  minZoom?: number;
  maxZoom?: number;
  buffer?: number;
  provider: VectorTileProvider;
  filter?: GeoJSONOptions["filter"];
  style?: GeoJSONOptions["style"] | ((feature: GeoJSONFeature, tile: VectorTileCoordinates) => Record<string, unknown>);
  paint?: MVTPaintRule[];
}

interface TileState {
  layer: GeoJSONLayer | null;
  controller: AbortController;
}

export interface VectorTileEventMap {
  tileloadstart: { coordinates: VectorTileCoordinates };
  tileload: { coordinates: VectorTileCoordinates; features: GeoJSONFeature[] };
  tileabort: { coordinates: VectorTileCoordinates };
  tileerror: { coordinates: VectorTileCoordinates; error: unknown };
}

export class VectorTileLayer extends LayerGroup<VectorTileEventMap> {
  readonly options: Required<VectorTileLayerOptions>;
  readonly tiles = new Map<string, TileState>();
  readonly _render = () => this.render();
  private _rect: TileRect | null = null;

  constructor(options: VectorTileLayerOptions) {
    super();
    if (typeof options.provider !== "function") throw new TypeError("VectorTileLayer provider is required");
    this.options = {
      minZoom: 0,
      maxZoom: 19,
      buffer: 1,
      filter: undefined,
      style: undefined,
      paint: [],
      pointToLayer: undefined,
      onEachFeature: undefined,
      ...options
    } as Required<VectorTileLayerOptions>;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    map.on("moveend", this._render);
    map.on("zoomend", this._render);
    this.render();
  }

  override onRemove(): void {
    const map = this.map;
    map?.off("moveend", this._render);
    map?.off("zoomend", this._render);
    this.clearTiles();
    super.onRemove();
  }

  clearTiles(): this {
    for (const tile of this.tiles.values()) {
      tile.controller.abort();
      if (tile.layer) this.removeLayer(tile.layer);
    }
    this.tiles.clear();
    this._rect = null;
    return this;
  }

  override render(): void {
    const map = this.map;
    if (!map) return;
    const z = Math.round(map.zoom);
    if (z < this.options.minZoom || z > this.options.maxZoom) {
      this.clearTiles();
      return;
    }
    const bounds = map.getBounds();
    const range = tileRange(bounds, z, this.options.buffer);
    const nextRect: TileRect = { z, left: range.minX, top: range.minY, right: range.maxX, bottom: range.maxY };
    const consider = (x: number, y: number): void => {
      const key = `${z}:${x}:${y}`;
      if (!this.tiles.has(key)) void this.#loadTile(x, y, z, key);
    };
    const forget = (x: number, y: number): void => {
      const key = `${z}:${x}:${y}`;
      const tile = this.tiles.get(key);
      if (!tile) return;
      tile.controller.abort();
      if (tile.layer) this.removeLayer(tile.layer);
      this.tiles.delete(key);
    };
    if (!this._rect || this._rect.z !== nextRect.z) {
      this.clearTiles();
      forEachTileInRect(nextRect, consider);
    } else {
      forEachTileRectDelta(this._rect, nextRect, consider, forget);
    }
    this._rect = nextRect;
  }

  async #loadTile(x: number, y: number, z: number, key: string): Promise<void> {
    const controller = new AbortController();
    const coordinates: VectorTileCoordinates = { x, y, z, bounds: tileBounds(x, y, z), signal: controller.signal };
    this.tiles.set(key, { layer: null, controller });
    this.emit("tileloadstart", { coordinates });
    try {
      const features = await this.options.provider(coordinates);
      if (controller.signal.aborted || !this.map || !this.tiles.has(key)) return;
      const sourceFeatures = features || [];
      const usePaint = this.options.style == null && this.options.paint.length > 0;
      const paintByFeature = new WeakMap<GeoJSONFeature, MVTPaintRule>();
      const renderedFeatures = usePaint ? sourceFeatures.flatMap((feature) => {
        const geometryType = feature.geometry?.type ?? "";
        const sourceLayer = String(feature.properties?.layer ?? "");
        const matches = this.options.paint.filter((paint) =>
          paint.layer === sourceLayer
          && z >= (paint.minZoom ?? -Infinity)
          && z <= (paint.maxZoom ?? Infinity)
          && (paint.type === "circle" ? geometryType.includes("Point")
            : paint.type === "line" ? geometryType.includes("Line")
              : geometryType.includes("Polygon"))
          && (!paint.filter || paint.filter(feature))
        );
        return matches.map((paint) => {
          const clone = { ...feature, properties: feature.properties ? { ...feature.properties } : feature.properties };
          paintByFeature.set(clone, paint);
          return clone;
        });
      }) : sourceFeatures;
      const layer = new GeoJSONLayer({ type: "FeatureCollection", features: renderedFeatures }, {
        ...this.options,
        filter: this.options.filter,
        pointToLayer: this.options.pointToLayer ?? (usePaint ? (feature, position) => {
          const paint = paintByFeature.get(feature);
          return circleMarker(position, { ...paintStyle(paint), radiusPixels: paint?.radius ?? 3 });
        } : undefined),
        onEachFeature: this.options.onEachFeature,
        popup: this.options.popup,
        popupOptions: this.options.popupOptions,
        style: usePaint ? (feature) => paintStyle(paintByFeature.get(feature)) : typeof this.options.style === "function"
          ? (feature) => (this.options.style as (feature: GeoJSONFeature, tile: VectorTileCoordinates) => Record<string, unknown>)(feature, coordinates)
          : this.options.style
      });
      this.tiles.set(key, { layer, controller });
      this.addLayer(layer);
      this.emit("tileload", { coordinates, features: features || [] });
    } catch (error) {
      if (controller.signal.aborted) this.emit("tileabort", { coordinates });
      else this.emit("tileerror", { coordinates, error });
      this.tiles.delete(key);
    }
  }
}

function paintStyle(paint?: MVTPaintRule): PathOptions {
  if (!paint) return {};
  const { layer: _layer, type: _type, minZoom: _min, maxZoom: _max, radius: _radius, filter: _filter, ...style } = paint;
  return style;
}

export function vectorTileLayer(options: VectorTileLayerOptions): VectorTileLayer {
  return new VectorTileLayer(options);
}

function tileRange(bounds: { south: number; west: number; north: number; east: number }, z: number, buffer: number) {
  const n = 2 ** z;
  const west = lngToTileX(bounds.west, z);
  const east = lngToTileX(bounds.east, z);
  const north = latToTileY(bounds.north, z);
  const south = latToTileY(bounds.south, z);
  return {
    minX: Math.max(0, Math.min(west, east) - buffer),
    maxX: Math.min(n - 1, Math.max(west, east) + buffer),
    minY: Math.max(0, Math.min(north, south) - buffer),
    maxY: Math.min(n - 1, Math.max(north, south) + buffer)
  };
}

function tileBounds(x: number, y: number, z: number): LatLngBoundsLike {
  const n = 2 ** z;
  const west = x / n * 360 - 180;
  const east = (x + 1) / n * 360 - 180;
  const north = tileYToLat(y, z);
  const south = tileYToLat(y + 1, z);
  return { south, west, north, east };
}

function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const radians = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * 2 ** z);
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
