import {
  createMap as createStandardMap,
  geoJSON,
  marker,
  polygon,
  polyline,
  tileLayer,
  type GeoJSONData,
  type GeoJSONLayer,
  type GeoJSONOptions,
  type LatLngLike,
  type Layer,
  type MapOptions,
  type Marker,
  type MarkerOptions,
  type Orihon,
  type OverlayContent,
  type PathOptions,
  type Polygon,
  type Polyline,
  type PopupOptions,
  type TileLayer,
  type TileLayerOptions,
  type TileTemplate,
  type TooltipOptions
} from "./standard.js";

export type EasyBasemapOptions = Omit<TileLayerOptions, "attribution"> & {
  url: TileTemplate;
  attribution?: string;
};

export type EasyBasemap = TileTemplate | EasyBasemapOptions;

export interface EasyMapOptions extends MapOptions {
  /** Optional raster basemap created and added with the map. */
  basemap?: EasyBasemap | false | null;
}

export interface EasyMarkerOptions extends MarkerOptions {
  position: LatLngLike;
  popup?: OverlayContent;
  popupOptions?: PopupOptions;
  tooltip?: OverlayContent;
  tooltipOptions?: TooltipOptions;
}

export type EasyMarkerLayerOptions = Omit<EasyMarkerOptions, "position">;

export interface EasyMarkerDescription extends EasyMarkerOptions {
  type: "marker";
}

export interface EasyPathStyle extends PathOptions {
  /** Easy alias for `strokeWidth`; the canonical name wins when both are present. */
  width?: number;
  /** Easy alias for `strokeOpacity`; the canonical name wins when both are present. */
  opacity?: number;
}

interface EasyPathDescription {
  coordinates: LatLngLike[];
  style?: EasyPathStyle;
  popup?: OverlayContent;
  popupOptions?: PopupOptions;
  tooltip?: OverlayContent;
  tooltipOptions?: TooltipOptions;
}

export interface EasyPolylineDescription extends EasyPathDescription {
  type: "polyline";
}

export interface EasyPolygonDescription extends Omit<EasyPathDescription, "coordinates"> {
  type: "polygon";
  coordinates: LatLngLike[] | LatLngLike[][];
}

export interface EasyGeoJSONDescription {
  type: "geojson";
  data?: GeoJSONData | null;
  options?: GeoJSONOptions;
}

export interface EasyRasterDescription {
  type: "raster";
  url: TileTemplate;
  options?: TileLayerOptions;
}

export type EasyAddDescription =
  | EasyMarkerDescription
  | EasyPolylineDescription
  | EasyPolygonDescription
  | EasyGeoJSONDescription
  | EasyRasterDescription;

export type EasyAddResult = Marker | Polyline | Polygon | GeoJSONLayer | TileLayer;

export interface EasyMap extends Orihon {
  /** Add an existing layer and return the map. */
  add(layer: Layer): this;
  /** Create and add a layer from a declarative, discriminated description. */
  add(description: EasyMarkerDescription): Marker;
  add(description: EasyPolylineDescription): Polyline;
  add(description: EasyPolygonDescription): Polygon;
  add(description: EasyGeoJSONDescription): GeoJSONLayer;
  add(description: EasyRasterDescription): TileLayer;
  /** Create, configure and add a marker in one call. */
  addMarker(options: EasyMarkerOptions): Marker;
  addMarker(position: LatLngLike, options?: EasyMarkerLayerOptions): Marker;
  /** Create and add a raster tile layer. */
  addTileLayer(template: TileTemplate, options?: TileLayerOptions): TileLayer;
  /** Create and add a polyline. */
  addPolyline(points: LatLngLike[], options?: PathOptions): Polyline;
  /** Create and add a polygon, including optional inner rings. */
  addPolygon(points: LatLngLike[] | LatLngLike[][], options?: PathOptions): Polygon;
  /** Create and add a GeoJSON layer. */
  addGeoJSON(data?: GeoJSONData | null, options?: GeoJSONOptions): GeoJSONLayer;
  /** Replace the convenience basemap without affecting other map layers. */
  setBasemap(basemap: EasyBasemap | false | null): this;
  /** Return the basemap owned by the Easy adapter, if one is active. */
  getBasemap(): TileLayer | null;
}

/**
 * Beginner-oriented Standard API adapter. It returns the regular Orihon map;
 * only the instance-local convenience methods are added.
 */
export function createMap(container: string | HTMLElement, options: EasyMapOptions = {}): EasyMap {
  const { basemap, ...mapOptions } = options;
  const map = createStandardMap(container, mapOptions) as EasyMap;
  const addExistingLayer = map.add.bind(map);
  let activeBasemap: TileLayer | null = null;

  Object.defineProperties(map, {
    add: {
      configurable: true,
      value(input: Layer | EasyAddDescription): EasyMap | EasyAddResult {
        if (!input || typeof input !== "object" || !("type" in input)) {
          return addExistingLayer(input as Layer);
        }
        switch (input.type) {
          case "marker": {
            const { type: _type, position, popup, popupOptions, tooltip, tooltipOptions, ...appearance } = input;
            const layer = marker(position, appearance);
            if ("popup" in input) layer.bindPopup(popup, popupOptions);
            if ("tooltip" in input) layer.bindTooltip(tooltip, tooltipOptions);
            return layer.addTo(map);
          }
          case "polyline":
          case "polygon": {
            const { coordinates, style, popup, popupOptions, tooltip, tooltipOptions } = input;
            const { width, opacity, ...pathOptions } = style ?? {};
            if (pathOptions.strokeWidth === undefined && width !== undefined) pathOptions.strokeWidth = width;
            if (pathOptions.strokeOpacity === undefined && opacity !== undefined) pathOptions.strokeOpacity = opacity;
            const layer = input.type === "polyline"
              ? polyline(coordinates as LatLngLike[], pathOptions)
              : polygon(coordinates, pathOptions);
            if ("popup" in input) layer.bindPopup(popup, popupOptions);
            if ("tooltip" in input) layer.bindTooltip(tooltip, tooltipOptions);
            return layer.addTo(map);
          }
          case "geojson":
            return geoJSON(input.data, input.options).addTo(map);
          case "raster":
            return tileLayer(input.url, { renderer: "dom", ...input.options }).addTo(map);
          default:
            throw new TypeError(`Unsupported map.add description type: ${String((input as { type?: unknown }).type)}`);
        }
      }
    },
    addMarker: {
      configurable: true,
      value(input: EasyMarkerOptions | LatLngLike, options: EasyMarkerLayerOptions = {}): Marker {
        if (!input || typeof input !== "object") throw new TypeError("addMarker position or options are required");
        const markerOptions: EasyMarkerOptions = !Array.isArray(input) && "position" in input
          ? input as EasyMarkerOptions
          : { ...options, position: input as LatLngLike };
        const { position, popup, popupOptions, tooltip, tooltipOptions, ...appearance } = markerOptions;
        if (position === undefined || position === null) {
          throw new TypeError("addMarker position is required");
        }
        const layer = marker(position, appearance);
        if ("popup" in markerOptions) layer.bindPopup(popup, popupOptions);
        if ("tooltip" in markerOptions) layer.bindTooltip(tooltip, tooltipOptions);
        return layer.addTo(map);
      }
    },
    addTileLayer: {
      configurable: true,
      value(template: TileTemplate, tileOptions: TileLayerOptions = {}): TileLayer {
        return tileLayer(template, { renderer: "dom", ...tileOptions }).addTo(map);
      }
    },
    addPolyline: {
      configurable: true,
      value(points: LatLngLike[], pathOptions: PathOptions = {}): Polyline {
        return polyline(points, pathOptions).addTo(map);
      }
    },
    addPolygon: {
      configurable: true,
      value(points: LatLngLike[] | LatLngLike[][], pathOptions: PathOptions = {}): Polygon {
        return polygon(points, pathOptions).addTo(map);
      }
    },
    addGeoJSON: {
      configurable: true,
      value(data?: GeoJSONData | null, geojsonOptions: GeoJSONOptions = {}): GeoJSONLayer {
        return geoJSON(data, geojsonOptions).addTo(map);
      }
    },
    setBasemap: {
      configurable: true,
      value(next: EasyBasemap | false | null): EasyMap {
        activeBasemap?.remove();
        activeBasemap = null;
        if (!next) return map;
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
      value(): TileLayer | null {
        return activeBasemap;
      }
    }
  });

  if (basemap) map.setBasemap(basemap);
  return map;
}
