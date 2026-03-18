import {
  createMap as createStandardMap,
  geoJSON,
  marker,
  polygon,
  polyline,
  tileLayer,
  type GeoJSONInput,
  type GeoJSONLayer,
  type GeoJSONOptions,
  type LatLngLike,
  Layer,
  type MapOptions,
  type Marker,
  type MarkerAppearance,
  type MarkerIcon,
  type Orihon,
  type OverlayContent,
  type PathOptions,
  type Polygon,
  type Polyline,
  type PopupOptions,
  type TileLayerOptions,
  type TileTemplate,
  type TooltipOptions,
  type RasterTileLayer
} from "./standard.js";
import { validateMarkerOptions, type MarkerOptions } from "./layers/marker.js";

export type EasyBasemapOptions = Omit<TileLayerOptions, "attribution"> & {
  url: TileTemplate;
  attribution?: string;
};

/** A ready layer, raster URL/template, or raster options used as the map basemap. */
export type EasyBasemap = Layer | TileTemplate | EasyBasemapOptions;

export interface EasyMapOptions extends MapOptions {
  /** Optional ready layer or raster basemap created and added with the map. */
  basemap?: EasyBasemap | false | null;
}

interface EasyOverlayExtras {
  popup?: OverlayContent;
  popupOptions?: PopupOptions;
  tooltip?: OverlayContent;
  tooltipOptions?: TooltipOptions;
}

interface EasyMarkerShared extends EasyOverlayExtras {
  position: LatLngLike;
  title?: string;
  className?: string;
  draggable?: boolean;
  ariaLabel?: string;
  opacity?: number;
  zIndexOffset?: number;
  keyboard?: boolean;
  interactive?: boolean;
  rotation?: number;
  rotationOrigin?: string;
  pane?: string;
  attribution?: string;
  /** Flat appearance fields belong under `appearance`. */
  shape?: never;
  color?: never;
  strokeColor?: never;
  size?: never;
  strokeWidth?: never;
  html?: never;
}

/** Object-first Easy marker: exactly one of appearance / content / icon. */
export type EasyMarkerOptions = EasyMarkerShared & (
  | { appearance?: MarkerAppearance; content?: never; icon?: never; anchor?: [number, number] }
  | { appearance?: never; content: Node | string | number; icon?: never; anchor?: [number, number] }
  | { appearance?: never; content?: never; icon: MarkerIcon; anchor?: never }
);

export interface EasyPolylineOptions extends EasyOverlayExtras {
  points: LatLngLike[];
  style?: PathOptions;
}

export interface EasyPolygonOptions extends EasyOverlayExtras {
  /** Outer ring, or rings with holes. */
  rings: LatLngLike[] | LatLngLike[][];
  style?: PathOptions;
}

export interface EasyTileLayerOptions extends TileLayerOptions {
  url: TileTemplate;
}

export interface EasyGeoJSONOptions extends GeoJSONOptions {
  data?: GeoJSONInput | null;
}

/**
 * Map-centric Standard adapter. Easy sentences are object-first:
 * `map.addMarker({ position, appearance })`, `map.addPolyline({ points, style })`.
 */
export interface EasyMap extends Orihon {
  addMarker(options: EasyMarkerOptions): Marker;
  addTileLayer(options: EasyTileLayerOptions): RasterTileLayer;
  addPolyline(options: EasyPolylineOptions): Polyline;
  addPolygon(options: EasyPolygonOptions): Polygon;
  addGeoJSON(options?: EasyGeoJSONOptions): GeoJSONLayer;
  setBasemap(basemap: EasyBasemap | false | null): this;
  getBasemap(): Layer | null;
}

function bindEasyOverlays<T extends { bindPopup(content: OverlayContent, options?: PopupOptions): unknown; bindTooltip(content: OverlayContent, options?: TooltipOptions): unknown }>(
  layer: T,
  options: EasyOverlayExtras
): T {
  if ("popup" in options) layer.bindPopup(options.popup as OverlayContent, options.popupOptions);
  if ("tooltip" in options) layer.bindTooltip(options.tooltip as OverlayContent, options.tooltipOptions);
  return layer;
}

function toMarkerOptions(options: EasyMarkerOptions): MarkerOptions {
  const {
    position: _position,
    popup: _popup,
    popupOptions: _popupOptions,
    tooltip: _tooltip,
    tooltipOptions: _tooltipOptions,
    appearance,
    content,
    icon,
    ...rest
  } = options;
  const modes = Number(appearance !== undefined) + Number(content !== undefined) + Number(icon !== undefined);
  if (modes > 1) {
    throw new TypeError("Easy addMarker accepts exactly one visual mode: appearance, content or icon");
  }
  if (icon !== undefined) return { ...rest, icon } as MarkerOptions;
  if (content !== undefined) return { ...rest, content } as MarkerOptions;
  return { ...rest, ...appearance } as MarkerOptions;
}

/**
 * Beginner-oriented Standard API adapter. It returns the regular Orihon map;
 * only the instance-local convenience methods are added.
 */
export function createMap(container: string | HTMLElement, options: EasyMapOptions = {}): EasyMap {
  const { basemap, ...mapOptions } = options;
  const map = createStandardMap(container, mapOptions) as EasyMap;
  let activeBasemap: Layer | null = null;

  Object.defineProperties(map, {
    addMarker: {
      configurable: true,
      value(options: EasyMarkerOptions): Marker {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw new TypeError("addMarker({ position, ... }) options object is required");
        }
        if (options.position === undefined || options.position === null) {
          throw new TypeError("addMarker position is required");
        }
        const markerOptions = toMarkerOptions(options);
        validateMarkerOptions(markerOptions);
        const layer = marker(options.position, markerOptions);
        return bindEasyOverlays(layer, options).addTo(map);
      }
    },
    addTileLayer: {
      configurable: true,
      value(options: EasyTileLayerOptions): RasterTileLayer {
        if (!options || typeof options !== "object" || !("url" in options)) {
          throw new TypeError("addTileLayer({ url, ... }) options object is required");
        }
        const { url, ...tileOptions } = options;
        return tileLayer(url, { renderer: "dom", ...tileOptions }).addTo(map);
      }
    },
    addPolyline: {
      configurable: true,
      value(options: EasyPolylineOptions): Polyline {
        if (!options || typeof options !== "object" || !Array.isArray(options.points)) {
          throw new TypeError("addPolyline({ points, style? }) options object is required");
        }
        const layer = polyline(options.points, options.style ?? {});
        return bindEasyOverlays(layer, options).addTo(map);
      }
    },
    addPolygon: {
      configurable: true,
      value(options: EasyPolygonOptions): Polygon {
        if (!options || typeof options !== "object" || options.rings == null) {
          throw new TypeError("addPolygon({ rings, style? }) options object is required");
        }
        const layer = polygon(options.rings, options.style ?? {});
        return bindEasyOverlays(layer, options).addTo(map);
      }
    },
    addGeoJSON: {
      configurable: true,
      value(options: EasyGeoJSONOptions = {}): GeoJSONLayer {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw new TypeError("addGeoJSON({ data?, ... }) options object is required");
        }
        const { data = null, ...geojsonOptions } = options;
        return geoJSON(data, geojsonOptions).addTo(map);
      }
    },
    setBasemap: {
      configurable: true,
      value(next: EasyBasemap | false | null): EasyMap {
        if (next === activeBasemap) return map;
        activeBasemap?.remove();
        activeBasemap = null;
        if (!next) return map;
        if (next instanceof Layer) {
          activeBasemap = next.addTo(map);
          return map;
        }
        if (typeof next === "string" || typeof next === "function") {
          activeBasemap = tileLayer(next, { renderer: "dom" }).addTo(map);
          return map;
        }
        if (!("url" in next)) throw new TypeError("basemap.url is required");
        const { url, ...tileOptions } = next;
        activeBasemap = tileLayer(url, { renderer: "dom", ...tileOptions }).addTo(map);
        return map;
      }
    },
    getBasemap: {
      configurable: true,
      value(): Layer | null {
        return activeBasemap;
      }
    }
  });

  if (basemap) map.setBasemap(basemap);
  return map;
}
