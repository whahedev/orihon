export { Evented } from "./events.js";
export { OrihonError, DestroyedError, UnsupportedCapabilityError } from "./errors.js";
export type { OrihonErrorCode, OrihonErrorOptions } from "./errors.js";
export { Layer } from "./layer.js";
export { InteractiveLayer } from "./interactive-layer.js";
export { LayerGroup, FeatureGroup, featureGroup } from "./layer-group.js";
export { Renderer } from "./renderer.js";
export { Orihon, createMap } from "./map.js";
export { CRS, CRSCompatibilityError } from "./crs.js";
export { GridLayer } from "./layers/grid-layer.js";
export { TileLayer, tileLayer } from "./layers/tile-layer.js";
export { GPUTileLayer } from "./layers/gpu-tile-layer.js";
export { WTinyLfu, CountMinSketch, wTinyLfu } from "./services/tiny-lfu.js";
export { WMSTileLayer, wmsTileLayer } from "./layers/wms-tile-layer.js";
export { WMTSTileLayer, wmtsTileLayer, createWMTSFromCapabilities } from "./layers/wmts-tile-layer.js";
export { VectorTileLayer, vectorTileLayer } from "./layers/vector-tile-layer.js";
export { createMVTProvider, decodeMVT } from "./layers/mvt.js";
export { Marker, marker, markerShapeMetrics } from "./layers/marker.js";
export { Icon, DivIcon, icon } from "./layers/icon.js";
export { TextLayer, textLayer } from "./layers/text-layer.js";
export {
  SvgLayer,
  PathLayer,
  Polyline,
  Polygon,
  Rectangle,
  Circle,
  CircleMarker,
  polyline,
  polygon,
  rectangle,
  circle,
  circleMarker
} from "./layers/vector.js";
export { GeoJSONLayer, geoJSON } from "./layers/geojson.js";
export { DivOverlay, Popup, Tooltip, popup, tooltip } from "./overlays/div-overlay.js";
export { ImageOverlay, imageOverlay } from "./overlays/image-overlay.js";
export { VideoOverlay, videoOverlay } from "./overlays/video-overlay.js";
export { SVGOverlay, svgOverlay, sanitizeSvgElement } from "./overlays/svg-overlay.js";
export {
  Control,
  ZoomControl,
  ScaleControl,
  GeolocationControl,
  AttributionControl,
  LayersControl,
  CustomControl,
  zoomControl,
  scaleControl,
  geolocationControl,
  attributionControl,
  layersControl,
  customControl
} from "./ui/control.js";
export {
  enLocale,
  locales,
  resolveLocale,
  ensureLocalePacks,
  registerLocalePacks
} from "./ui/locale.js";
export { SpatialGridIndex, spatialGridIndex } from "./services/spatial-grid-index.js";
export { TrafficLayer, trafficLayer } from "./services/traffic-layer.js";
export { SearchProvider, searchProvider } from "./services/search.js";
export { RoutingLayer, createStraightLineRoutingProvider, routingLayer } from "./services/routing.js";
export { SuggestProvider, SuggestWidget, createSuggestProvider, createSuggestWidget } from "./services/suggest.js";
export { WebGLPointLayer, webglPointLayer } from "./layers/webgl-point-layer.js";
export { WebGLSymbolLayer, webglSymbolLayer } from "./layers/webgl-symbol-layer.js";
export { WebGLStyledPathBatch } from "./layers/webgl-styled-path-batch.js";
export { WebGLPolygonBatch, webglPolygonBatch } from "./layers/webgl-polygon-batch.js";
export { HeatLayer, heatLayer } from "./layers/heat.js";
export { WebGLPathBatch } from "./layers/webgl-path-batch.js";
export { pathBatch } from "./layers/path-batch.js";
export { buildHeat, heatSupport } from "./services/heat.js";
export {
  GeometryWorkerPool,
  GeometryWorkerError,
  createGeometryWorkerPool,
  preparePointBatch,
  preparePointBatchAsync
} from "./services/geometry-worker.js";
export { OfflineTileCache, offlineTileCache } from "./services/offline-cache.js";
export { PerformanceInspector, performanceInspector } from "./services/performance.js";
export { createMapAdapter, defineOrihonElement } from "./services/framework-adapters.js";
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
  latLngs,
  lngLats,
  fromGeoJSONPositions,
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
// Named in the signatures of root exports (`textLayer`, `zoomForBounds`), so they must be
// nameable from the root entry too, not only from `orihon/core`.
export type {
  FeatureId,
  FeatureSourceChange,
  FeatureSourceDelta,
  FeatureSourceListener,
  ReadonlyFeatureSource,
  SourceSnapshot
} from "./source-types.js";
export type { LayerOptions, LayerEventMap, QueryHit, QueryOptions, QuerySource } from "./layer.js";
export type { RendererOptions } from "./renderer.js";
export type { BehaviorOptions, MapBehaviorName, MapEventMap, MapOptions, MapSize, ControlPosition, CameraAnimation, CameraMotionOptions, FitBoundsOptions } from "./map.js";
export type { CameraState, CameraOrigin } from "./camera.js";
export type { ExportPngOptions, PrintMapOptions } from "./services/map-export.js";
export type { CoordinateReferenceSystem, CRSInput } from "./crs.js";
export type { GridLayerOptions, ResolvedGridLayerOptions } from "./layers/grid-layer.js";
export type { PointLike, LatLngLike, LatLngBoundsLike, ViewSize } from "./geo.js";
export type { TileCoordinates, TileTemplate, TileLayerOptions, TileRedrawFlag, RasterTileRendererKind, RasterTileLayer, RasterTileStats, GPUTileFactory, TileLayerEventMap, RasterTileEventDetail } from "./layers/tile-layer.js";
export type { GPUTileBackend, GPUTileLayerOptions, GPUTileLayerStats, GPUTileLayerEventMap } from "./layers/gpu-tile-layer.js";
export type { WMSParameterValue, WMSTileLayerOptions } from "./layers/wms-tile-layer.js";
export type { WMTSTileLayerOptions, WMTSCapabilitiesConfig } from "./layers/wmts-tile-layer.js";
export type { MVTPaintRule, VectorTileCoordinates, VectorTileLayerOptions, VectorTileProvider, VectorTileEventMap } from "./layers/vector-tile-layer.js";
export type { MVTDecodeOptions } from "./layers/mvt.js";
export type { MarkerOptions, MarkerAppearance, MarkerShape, MarkerEventMap } from "./layers/marker.js";
export type { IconOptions, DivIconOptions, MarkerIcon } from "./layers/icon.js";
export type { TextLayerOptions, TextLayerEventMap } from "./layers/text-layer.js";
export type { PathOptions, CircleMarkerOptions, CircleRadius, PathEventMap } from "./layers/vector.js";
export type {
  GeoJSONInput,
  GeoJSONAsyncInput,
  GeoJSONAsyncOptions,
  GeoJSONData,
  GeoJSONFeature,
  IdentifiedGeoJSONFeature,
  GeoJSONFeatureCollection,
  GeoJSONGeometry,
  GeoJSONGeometryCollection,
  GeoJSONOptions,
  GeoJSONPopupContent,
  GeoJSONPopupFactory,
  GeoJSONPointToLayer,
  GeoJSONPosition,
  GeoJSONRendererMode,
  GeoJSONStyleFunction
} from "./layers/geojson.js";
export type {
  OverlayContent,
  OverlayContentContext,
  OverlayContentFactory,
  OverlayMountable,
  OverlayRenderable,
  DivOverlayOptions,
  DivOverlayEventMap,
  OverlayLifecycleEventMap,
  PopupOptions,
  TooltipOptions
} from "./overlays/div-overlay.js";
export type { MediaOverlayEventMap } from "./overlays/media-overlay.js";
export type { ImageOverlayOptions, ImageOverlayEventMap } from "./overlays/image-overlay.js";
export type { VideoOverlayOptions, VideoOverlayEventMap } from "./overlays/video-overlay.js";
export type { SVGOverlayContent, SVGOverlayOptions } from "./overlays/svg-overlay.js";
export type {
  ControlOptions,
  ZoomControlOptions,
  ScaleControlOptions,
  GeolocationControlOptions,
  AttributionOptions,
  LayersControlOptions,
  CustomControlOptions,
  CustomControlContent
} from "./ui/control.js";
export type { OrihonLocale, LocaleInput, LocaleName } from "./ui/locale.js";
export type { SpatialId, SpatialRecord } from "./services/spatial-grid-index.js";
export type { TrafficLayerOptions, TrafficState, TrafficEventMap } from "./services/traffic-layer.js";
export type { SearchAdapter, SearchContext, SearchResult, SearchProviderSource, SearchProviderOptions, SearchProviderConfig, ReverseFallback } from "./services/search.js";
export type { RouteResult, RouteWaypoint, RoutingContext, RoutingLayerOptions, RoutingProvider, RoutingEventMap } from "./services/routing.js";
export type { SuggestOptions, SuggestContext, SuggestFetcher, SuggestWidgetOptions, SuggestWidgetEventMap } from "./services/suggest.js";
export type { WebGLPointInput, WebGLPointDataOptions, WebGLPointAsyncDataOptions, WebGLPointLayerOptions, WebGLPointLayerStats, WebGLPointEventMap } from "./layers/webgl-point-layer.js";
export type { WebGLSymbolInstance, WebGLSymbolLayerOptions, WebGLSymbolEventMap } from "./layers/webgl-symbol-layer.js";
export type { StyledPathInput, StyledPathStyle, WebGLStyledPathBatchOptions } from "./layers/webgl-styled-path-batch.js";
export type { PathBatch, PathBatchMode, PathBatchOptions, UniformPathBatchOptions, FeaturePathBatchOptions } from "./layers/path-batch.js";
export type { PolygonBatchInput, PolygonBatchStyle, WebGLPolygonBatchOptions } from "./layers/webgl-polygon-batch.js";
export type { WebGLPathBatchOptions } from "./layers/webgl-path-batch.js";
export type {
  HeatLayerOptions,
  HeatAsyncDataOptions,
  HeatLayerStats,
  HeatEventMap,
  HeatPointerDetail,
  HeatGradient,
  HeatFeature
} from "./layers/heat.js";
export type {
  HeatMode,
  HeatBackend,
  HeatEvaluation,
  ResolvedHeatBackend,
  HeatPoint,
  HeatGrid,
  HeatContour,
  HeatOptions,
  HeatProfile,
  HeatResult,
  HeatSupport
} from "./services/heat.js";
export { buildClusterLayout, buildClusterIndex, queryClusterLayout } from "./services/cluster-layout.js";
export type {
  ClusterIndex,
  ClusterLayoutCluster,
  ClusterLayoutId,
  ClusterLayoutRequest,
  ClusterLayoutResult,
  ClusterLayoutSingle
} from "./services/cluster-layout.js";
export type { GeometryPointInput, GeometryPrepareOptions, GeometryWorkerOptions, PreparedPointBatch } from "./services/geometry-worker.js";
export type {
  OfflineServiceWorkerOptions,
  OfflineTileCacheOptions,
  OfflineTileCacheStats,
  OfflineTileFailure,
  OfflineTileFailureStage,
  PrefetchTileLayerOptions
} from "./services/offline-cache.js";
export type { PerformanceInspectorOptions, PerformanceSnapshot, PerformanceEventMap } from "./services/performance.js";
export type { OrihonElementOptions, MapAdapter, MapUpdateOptions } from "./services/framework-adapters.js";
