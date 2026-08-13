export { Evented } from "./events.js";
export { Layer } from "./layer.js";
export { LayerGroup, FeatureGroup, featureGroup } from "./layer-group.js";
export { Renderer } from "./renderer.js";
export { Orihon, createMap } from "./map.js";
export { CRS, CRSCompatibilityError } from "./crs.js";
export { GridLayer, gridLayer } from "./layers/grid-layer.js";
export { TileLayer, tileLayer, registerWebGLTileFactory } from "./layers/tile-layer.js";
export { WebGLTileLayer, webglTileLayer } from "./layers/webgl-tile-layer.js";
import { registerWebGLTileFactory } from "./layers/tile-layer.js";
import { WebGLTileLayer } from "./layers/webgl-tile-layer.js";
// Advanced: enable GPU raster tiles for tileLayer({ renderer: "webgl" | "auto" }).
registerWebGLTileFactory((template, options) => new WebGLTileLayer(template, options));
export { WMSTileLayer, wmsTileLayer } from "./layers/wms-tile-layer.js";
export { WMTSTileLayer, wmtsTileLayer, createWMTSFromCapabilities } from "./layers/wmts-tile-layer.js";
export { VectorTileLayer, vectorTileLayer } from "./layers/vector-tile-layer.js";
export { createMVTProvider, decodeMVT } from "./layers/mvt.js";
export { Marker, marker } from "./layers/marker.js";
export { MarkerCollection, markerCollection } from "./layers/marker-collection.js";
export { Icon, DivIcon, icon, divIcon } from "./layers/icon.js";
export { CanvasBaseLayer, canvasBaseLayer } from "./layers/canvas-base-layer.js";
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
import { registerGeoJSONWebGLBatch } from "./layers/geojson.js";
import { WebGLPathBatch } from "./layers/webgl-path-batch.js";
// Advanced: enable GPU GeoJSON lines for renderer "webgl" / "auto" on large sets.
registerGeoJSONWebGLBatch((options) => new WebGLPathBatch(options));
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
  ruLocale,
  arLocale,
  trLocale,
  zhLocale,
  deLocale,
  frLocale,
  daLocale,
  hiLocale,
  locales,
  resolveLocale
} from "./ui/locale.js";
export { ObjectManager, objectManager, OBJECT_MANAGER_PALETTE } from "./services/object-manager.js";
export { RemoteObjectManager, remoteObjectManager } from "./services/remote-object-manager.js";
export { SpatialGridIndex, spatialGridIndex } from "./services/spatial-grid-index.js";
export { TrafficLayer, trafficLayer } from "./services/traffic-layer.js";
export { SearchProvider, createArraySearchProvider, createSearchProvider } from "./services/search.js";
export { RoutingLayer, createStraightLineRoutingProvider, routingLayer } from "./services/routing.js";
export { SuggestProvider, SuggestWidget, createSuggestProvider, createSuggestWidget } from "./services/suggest.js";
export { WebGLPointLayer, webglPointLayer } from "./layers/webgl-point-layer.js";
export { HeatLayer, heatLayer } from "./layers/heat-layer.js";
export { WebGLHeatLayer, webglHeatLayer } from "./layers/webgl-heat-layer.js";
export { HeatIsolineLayer, heatIsolineLayer } from "./layers/heat-isoline-layer.js";
export { buildHeatIsolines } from "./services/heat-isolines.js";
export { GeometryWorkerPool, geometryWorkerPool, preparePointBatch } from "./services/geometry-worker.js";
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
  latLngBounds,
  bounds,
  extendBounds,
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

export type { OrihonEvent, EventHandler } from "./events.js";
export type { LayerOptions, QueryHit, QueryOptions, QuerySource } from "./layer.js";
export type { RendererOptions } from "./renderer.js";
export type { BehaviorOptions, MapBehaviorName, MapOptions, MapSize, ControlPosition } from "./map.js";
export type { ExportPngOptions, PrintMapOptions } from "./services/map-export.js";
export type { CoordinateReferenceSystem, CRSInput } from "./crs.js";
export type { GridLayerOptions, ResolvedGridLayerOptions } from "./layers/grid-layer.js";
export type { PointLike, LatLngLike, LatLngBoundsLike } from "./geo.js";
export type { TileCoordinates, TileTemplate, TileLayerOptions, WebGLTileFactory } from "./layers/tile-layer.js";
export type { WebGLTileLayerOptions, WebGLTileLayerStats } from "./layers/webgl-tile-layer.js";
export type { WMSParameterValue, WMSTileLayerOptions } from "./layers/wms-tile-layer.js";
export type { WMTSTileLayerOptions, WMTSCapabilitiesConfig } from "./layers/wmts-tile-layer.js";
export type { MVTPaintRule, VectorTileCoordinates, VectorTileLayerOptions, VectorTileProvider } from "./layers/vector-tile-layer.js";
export type { MVTDecodeOptions } from "./layers/mvt.js";
export type { MarkerOptions } from "./layers/marker.js";
export type { MarkerCollectionOptions, MarkerCollectionRenderer } from "./layers/marker-collection.js";
export type { IconOptions, DivIconOptions, MarkerIcon } from "./layers/icon.js";
export type { CanvasBaseLayerOptions } from "./layers/canvas-base-layer.js";
export type { TextLayerOptions } from "./layers/text-layer.js";
export type { PathOptions, CircleMarkerOptions } from "./layers/vector.js";
export type {
  GeoJSONData,
  GeoJSONFeature,
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
  PopupOptions,
  TooltipOptions
} from "./overlays/div-overlay.js";
export type { ImageOverlayOptions } from "./overlays/image-overlay.js";
export type { VideoOverlayOptions } from "./overlays/video-overlay.js";
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
export type {
  ClusterIconFactory,
  ClusterRenderer,
  ManagedObject,
  ObjectId,
  ObjectFilter,
  ObjectManagerOptions,
  ObjectManagerStats,
  ObjectPopupContent,
  ObjectPopupContext,
  ClusterPopupContent,
  ClusterPopupContext
} from "./services/object-manager.js";
export type { RemoteObjectLoadContext, RemoteObjectLoader, RemoteObjectManagerOptions } from "./services/remote-object-manager.js";
export type { SpatialId, SpatialRecord } from "./services/spatial-grid-index.js";
export type { TrafficLayerOptions, TrafficState } from "./services/traffic-layer.js";
export type { SearchAdapter, SearchContext, SearchResult } from "./services/search.js";
export type { RouteResult, RouteWaypoint, RoutingContext, RoutingLayerOptions, RoutingProvider } from "./services/routing.js";
export type { SuggestOptions, SuggestContext, SuggestFetcher, SuggestWidgetOptions } from "./services/suggest.js";
export type { WebGLPointInput, WebGLPointDataOptions, WebGLPointLayerOptions, WebGLPointLayerStats } from "./layers/webgl-point-layer.js";
export type { HeatPoint, HeatLayerOptions } from "./layers/heat-layer.js";
export type {
  WebGLHeatInput,
  WebGLHeatLayerOptions,
  WebGLHeatLayerStats
} from "./layers/webgl-heat-layer.js";
export type {
  HeatIsolineLayerOptions,
  HeatIsolineLayerStats,
  HeatIsolineGradient
} from "./layers/heat-isoline-layer.js";
export type {
  HeatIsolineInput,
  HeatIsolineBuildOptions,
  HeatIsolineRing,
  HeatIsolineResult
} from "./services/heat-isolines.js";
export { buildClusterLayout, buildClusterIndex, queryClusterLayout } from "./services/cluster-layout.js";
export type {
  ClusterIndex,
  ClusterLayoutCluster,
  ClusterLayoutId,
  ClusterLayoutRequest,
  ClusterLayoutResult,
  ClusterLayoutSingle
} from "./services/cluster-layout.js";
export type { GeometryPointInput, GeometryWorkerOptions, PreparedPointBatch } from "./services/geometry-worker.js";
export type { OfflineServiceWorkerOptions, OfflineTileCacheOptions, OfflineTileCacheStats } from "./services/offline-cache.js";
export type { PerformanceInspectorOptions, PerformanceSnapshot } from "./services/performance.js";
export type { OrihonElementOptions, MapAdapter } from "./services/framework-adapters.js";
