import { EARTH_RADIUS, TILE_SIZE, unproject } from "../geo.js";
import { TileLayer, modulo, type TileLayerOptions } from "./tile-layer.js";

export type WMSParameterValue = string | number | boolean;

export interface WMSTileLayerOptions extends TileLayerOptions {
  layers: string;
  styles?: string;
  format?: string;
  transparent?: boolean;
  version?: string;
  crs?: "EPSG:3857" | "EPSG:4326" | string;
  uppercase?: boolean;
  params?: Record<string, WMSParameterValue>;
}

export class WMSTileLayer extends TileLayer {
  readonly baseUrl: string;
  readonly uppercase: boolean;
  readonly wmsParams: Record<string, WMSParameterValue>;

  constructor(url: string, options: WMSTileLayerOptions) {
    const {
      layers,
      styles = "",
      format = "image/png",
      transparent = false,
      version = "1.3.0",
      crs = "EPSG:3857",
      uppercase = false,
      params = {},
      ...tileOptions
    } = options;
    if (!String(layers || "").trim()) throw new TypeError("WMSTileLayer requires a layers option");
    super("", tileOptions);
    this.baseUrl = String(url);
    this.uppercase = Boolean(uppercase);
    this.wmsParams = {
      layers: String(layers),
      styles: String(styles),
      format: String(format),
      transparent: Boolean(transparent),
      version: String(version),
      crs: String(crs),
      ...params
    };
  }

  override getTileUrl(x: number, y: number, z: number): string {
    const worldTiles = 2 ** z;
    const tileX = this.options.noWrap ? x : modulo(x, worldTiles);
    const bbox = this.#bbox(tileX, y, z);
    const version = String(this.wmsParams.version || "1.3.0");
    const crs = String(this.wmsParams.crs || "EPSG:3857");
    const coordinateSystemKey = Number.parseFloat(version) >= 1.3 ? "crs" : "srs";
    const parameters: Record<string, WMSParameterValue> = {
      service: "WMS",
      request: "GetMap",
      ...this.wmsParams,
      [coordinateSystemKey]: crs,
      width: this.options.tileSize,
      height: this.options.tileSize,
      bbox: this.#axisOrderedBbox(bbox, version, crs)
    };
    delete parameters[coordinateSystemKey === "crs" ? "srs" : "crs"];

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      query.set(this.uppercase ? key.toUpperCase() : key, String(value));
    }
    return `${this.baseUrl}${this.baseUrl.includes("?") ? "&" : "?"}${query.toString()}`;
  }

  setParams(params: Record<string, WMSParameterValue>, options?: { redraw?: boolean }): this;
  /** @deprecated Prefer `setParams(params, { redraw: false })`. */
  setParams(params: Record<string, WMSParameterValue>, noRedraw?: boolean): this;
  setParams(params: Record<string, WMSParameterValue>, noRedrawOrOptions: boolean | { redraw?: boolean } = false): this {
    Object.assign(this.wmsParams, params);
    const noRedraw = typeof noRedrawOrOptions === "object"
      ? noRedrawOrOptions.redraw === false
      : Boolean(noRedrawOrOptions);
    if (!noRedraw && this.map) {
      const map = this.map;
      map.removeLayer(this);
      map.addLayer(this);
    }
    return this;
  }

  getParams(): Readonly<Record<string, WMSParameterValue>> {
    return { ...this.wmsParams };
  }

  #bbox(x: number, y: number, z: number): [number, number, number, number] {
    const crs = String(this.wmsParams.crs || "EPSG:3857").toUpperCase();
    const worldTiles = 2 ** z;
    if (crs === "EPSG:4326") {
      const northWest = unproject([x * TILE_SIZE, y * TILE_SIZE], z);
      const southEast = unproject([(x + 1) * TILE_SIZE, (y + 1) * TILE_SIZE], z);
      return [northWest.lng, southEast.lat, southEast.lng, northWest.lat];
    }
    const halfWorld = Math.PI * EARTH_RADIUS;
    const tileSpan = (halfWorld * 2) / worldTiles;
    const west = -halfWorld + x * tileSpan;
    const east = west + tileSpan;
    const north = halfWorld - y * tileSpan;
    const south = north - tileSpan;
    return [west, south, east, north];
  }

  #axisOrderedBbox(
    bbox: [number, number, number, number],
    version: string,
    crs: string
  ): string {
    if (Number.parseFloat(version) >= 1.3 && crs.toUpperCase() === "EPSG:4326") {
      return `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`;
    }
    return bbox.join(",");
  }
}

export function wmsTileLayer(url: string, options: WMSTileLayerOptions): WMSTileLayer {
  return new WMSTileLayer(url, options);
}
