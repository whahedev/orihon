export { Evented } from "./events.js";
export { OrihonError, DestroyedError, UnsupportedCapabilityError } from "./errors.js";
export type { OrihonErrorCode, OrihonErrorOptions } from "./errors.js";
/**
 * Core layer contract. Popup and tooltip binding lives on `InteractiveLayer`, exported from
 * `orihon/standard` and `orihon` — the tiers that actually ship the overlay implementation.
 */
export { Layer } from "./layer.js";
export { Orihon, createMap } from "./map.js";
export { CRS, CRSCompatibilityError } from "./crs.js";
export { GridLayer } from "./layers/grid-layer.js";
export { TileLayer, tileLayer } from "./layers/tile-layer.js";
export {
  Point,
  Bounds,
  LatLng,
  LatLngBounds,
  point,
  pointBounds,
  latLng,
  lngLat,
  fromGeoJSONPosition,
  toGeoJSONPosition,
  bounds,
  project,
  unproject,
  distance,
  destination,
  geodesicInterpolate,
  metersToPixels,
  clampLat,
  wrapLng,
  scale,
  zoomForBounds,
  TILE_SIZE,
  MAX_LAT,
  EARTH_RADIUS
} from "./geo.js";

export type { OrihonEvent, EventHandler, EventFor } from "./events.js";
export type { LayerOptions, LayerEventMap, QueryHit, QueryOptions, QuerySource } from "./layer.js";
export type { BehaviorOptions, MapBehaviorName, MapEventMap, MapOptions, MapSize, ControlPosition, CameraAnimation, CameraMotionOptions, FitBoundsOptions } from "./map.js";
export type { ExportPngOptions, PrintMapOptions } from "./services/map-export.js";
export type { CoordinateReferenceSystem, CRSInput } from "./crs.js";
export type { GridLayerOptions, ResolvedGridLayerOptions } from "./layers/grid-layer.js";
export type { TileCoordinates, TileTemplate, TileLayerOptions, TileRedrawFlag, RasterTileRendererKind, RasterTileLayer, RasterTileStats, TileLayerEventMap, RasterTileEventDetail } from "./layers/tile-layer.js";
export type { PointLike, LatLngLike, LatLngBoundsLike } from "./geo.js";
export type {
  FeatureId,
  FeatureSourceChange,
  FeatureSourceDelta,
  FeatureSourceListener,
  ReadonlyFeatureSource,
  SourceSnapshot
} from "./source-types.js";
