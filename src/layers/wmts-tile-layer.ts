import { TileLayer, modulo, type TileLayerOptions } from "./tile-layer.js";

export interface WMTSTileLayerOptions extends TileLayerOptions {
  layer: string;
  tileMatrixSet?: string;
  format?: string;
  style?: string;
  tileMatrixPrefix?: string;
  dimensions?: Record<string, string | number>;
}

export interface WMTSCapabilitiesConfig {
  template: string;
  options: Pick<WMTSTileLayerOptions, "layer" | "tileMatrixSet" | "format" | "style">;
}

export class WMTSTileLayer extends TileLayer {
  readonly wmtsOptions: Required<Pick<WMTSTileLayerOptions,
    "layer" | "tileMatrixSet" | "format" | "style" | "tileMatrixPrefix" | "dimensions">>;

  constructor(template: string, options: WMTSTileLayerOptions) {
    const {
      layer,
      tileMatrixSet = "EPSG:3857",
      format = "image/png",
      style = "default",
      tileMatrixPrefix = "",
      dimensions = {},
      ...tileOptions
    } = options;
    if (!String(layer || "").trim()) throw new TypeError("WMTSTileLayer requires a layer option");
    if (!template.includes("{TileMatrix}") || !template.includes("{TileCol}") || !template.includes("{TileRow}")) {
      throw new TypeError("WMTS REST template requires {TileMatrix}, {TileCol} and {TileRow}");
    }
    super(template, tileOptions);
    this.wmtsOptions = { layer, tileMatrixSet, format, style, tileMatrixPrefix, dimensions };
  }

  override getTileUrl(x: number, y: number, z: number): string {
    const tileX = this.options.noWrap ? x : modulo(x, 2 ** z);
    const values: Record<string, string | number> = {
      TileMatrix: `${this.wmtsOptions.tileMatrixPrefix}${z}`,
      TileCol: tileX,
      TileRow: this.options.tms ? 2 ** z - y - 1 : y,
      TileMatrixSet: this.wmtsOptions.tileMatrixSet,
      Layer: this.wmtsOptions.layer,
      Style: this.wmtsOptions.style,
      Format: this.wmtsOptions.format,
      ...this.wmtsOptions.dimensions
    };
    let url = String(this.template);
    for (const [key, value] of Object.entries(values)) url = url.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
    return url;
  }
}

export function wmtsTileLayer(template: string, options: WMTSTileLayerOptions): WMTSTileLayer {
  return new WMTSTileLayer(template, options);
}

/** Extract the first REST tile resource from a WMTS GetCapabilities document. */
export function createWMTSFromCapabilities(xml: string): WMTSCapabilitiesConfig {
  const layerBlock = xml.match(/<(?:\w+:)?Layer\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Layer>/i)?.[1] ?? "";
  const resource = layerBlock.match(/<(?:\w+:)?ResourceURL\b[^>]*resourceType=["']tile["'][^>]*>/i)?.[0]
    ?? layerBlock.match(/<(?:\w+:)?ResourceURL\b[^>]*>/i)?.[0]
    ?? "";
  const attribute = (name: string): string => resource.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1] ?? "";
  const identifier = (block: string): string => block.match(/<(?:\w+:)?Identifier\b[^>]*>([^<]+)<\/(?:\w+:)?Identifier>/i)?.[1]?.trim() ?? "";
  const matrixSet = layerBlock.match(/<(?:\w+:)?TileMatrixSet\b[^>]*>([^<]+)<\/(?:\w+:)?TileMatrixSet>/i)?.[1]?.trim() ?? "EPSG:3857";
  const styleBlock = layerBlock.match(/<(?:\w+:)?Style\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Style>/i)?.[1] ?? "";
  const template = attribute("template");
  if (!template) throw new TypeError("WMTS capabilities contain no REST tile ResourceURL");
  return {
    template: template.replaceAll("&amp;", "&"),
    options: {
      layer: identifier(layerBlock),
      tileMatrixSet: matrixSet,
      format: attribute("format") || "image/png",
      style: identifier(styleBlock) || "default"
    }
  };
}
