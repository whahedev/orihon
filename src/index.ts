export { Evented } from "./events.js";
export { Layer } from "./layer.js";
export { LayerGroup, FeatureGroup, featureGroup } from "./layer-group.js";
export { Renderer } from "./renderer.js";
export { Orihon, createMap } from "./map.js";
export { CRS, CRSCompatibilityError } from "./crs.js";
export { GridLayer } from "./layers/grid-layer.js";
export { TileLayer, tileLayer } from "./layers/tile-layer.js";
export { GPUTileLayer } from "./layers/gpu-tile-layer.js";
export { WTinyLfu, CountMinSketch, wTinyLfu } from "./services/tiny-lfu.js";
import { registerGpuTileFactory } from "./layers/tile-layer.js";
import { GPUTileLayer } from "./layers/gpu-tile-layer.js";
import { sniffPackedMLT } from "./layers/mlt.js";
import { decodePackedMVTWasm, mvtGeometryWasmSupported } from "./layers/mvt-wasm.js";
import { registerPackedMvtWasm, registerPackedTileSniffer } from "./layers/mvt.js";
// Advanced: enable GPU raster tiles for tileLayer({ renderer: "webgl" | "webgpu" | "auto" }).
registerGpuTileFactory((template, options) => new GPUTileLayer(template, {
  ...options,
  backend: options?.renderer === "webgl" || options?.renderer === "webgpu" ? options.renderer : "auto"
}));
// Advanced: createMVTProvider / decodeMVT accept MLT and use WASM geometry when present.
registerPackedTileSniffer(sniffPackedMLT);
if (mvtGeometryWasmSupported()) registerPackedMvtWasm(decodePackedMVTWasm);
export { WMSTileLayer, wmsTileLayer } from "./layers/wms-tile-layer.js";
export { WMTSTileLayer, wmtsTileLayer, createWMTSFromCapabilities } from "./layers/wmts-tile-layer.js";
export { VectorTileLayer, vectorTileLayer } from "./layers/vector-tile-layer.js";
export { createMVTProvider, decodeMVT } from "./layers/mvt.js";
export { Marker, marker, markerShapeMetrics } from "./layers/marker.js";
export { MarkerCollection } from "./layers/marker-collection.js";
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
  locales,
  resolveLocale,
  ensureLocalePacks,
  registerLocalePacks
} from "./ui/locale.js";
export {
  ruLocale,
  arLocale,
  trLocale,
  zhLocale,
  deLocale,
  frLocale,
  daLocale,
  hiLocale,
  localePacks
} from "./ui/locale-packs.js";
import { registerLocalePacks } from "./ui/locale.js";
import { localePacks } from "./ui/locale-packs.js";
registerLocalePacks(localePacks);
export { ObjectManager, OBJECT_MANAGER_PALETTE } from "./services/object-manager.js";
export { RemoteObjectManager } from "./services/remote-object-manager.js";
export { objectManager } from "./services/object-manager-factory.js";
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
  geometryWorkerPool,
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

export type { OrihonEvent, EventHandler } from "./events.js";
export type { LayerOptions, QueryHit, QueryOptions, QuerySource } from "./layer.js";
export type { RendererOptions } from "./renderer.js";
export type { BehaviorOptions, MapBehaviorName, MapOptions, MapSize, ControlPosition, SetViewOptions } from "./map.js";
export type { CameraState, CameraOrigin } from "./camera.js";
export type { ExportPngOptions, PrintMapOptions } from "./services/map-export.js";
export type { CoordinateReferenceSystem, CRSInput } from "./crs.js";
export type { GridLayerOptions, ResolvedGridLayerOptions } from "./layers/grid-layer.js";
export type { PointLike, LatLngLike, LatLngBoundsLike } from "./geo.js";
export type { TileCoordinates, TileTemplate, TileLayerOptions, GPUTileFactory } from "./layers/tile-layer.js";
export type { GPUTileBackend, GPUTileLayerOptions, GPUTileLayerStats } from "./layers/gpu-tile-layer.js";
export type { WMSParameterValue, WMSTileLayerOptions } from "./layers/wms-tile-layer.js";
export type { WMTSTileLayerOptions, WMTSCapabilitiesConfig } from "./layers/wmts-tile-layer.js";
export type { MVTPaintRule, VectorTileCoordinates, VectorTileLayerOptions, VectorTileProvider } from "./layers/vector-tile-layer.js";
export type { MVTDecodeOptions } from "./layers/mvt.js";
export type { MarkerOptions, MarkerAppearance, MarkerShape } from "./layers/marker.js";
export type { MarkerCollectionOptions, MarkerCollectionRenderer } from "./layers/marker-collection.js";
export type { IconOptions, DivIconOptions, MarkerIcon } from "./layers/icon.js";
export type { TextLayerOptions } from "./layers/text-layer.js";
export type { PathOptions, CircleMarkerOptions, CircleRadius } from "./layers/vector.js";
export type {
  GeoJSONInput,
  GeoJSONAsyncInput,
  GeoJSONAsyncOptions,
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
  ManagedGeometry,
  ManagedPointGeometry,
  ManagedLineStringGeometry,
  ManagedPolygonGeometry,
  ObjectId,
  ObjectFilter,
  ObjectManagerAsyncOptions,
  ObjectManagerOptions,
  ObjectManagerStats,
  ObjectPopupContent,
  ObjectPopupContext,
  ObjectState,
  ObjectStateValue,
  ObjectStyle,
  ObjectStyleContext,
  ObjectStyleResolver,
  ObjectLabelStyle,
  ObjectLineStyle,
  ObjectPolygonStyle,
  ObjectTrailStyle,
  ObjectCollisionMode,
  ObjectGradientStop,
  ObjectSearchOptions,
  ObjectSearchResult,
  ClusterPropertiesConfig,
  ClusterPropertyDefinition,
  ObjectVisualizationMode,
  ObjectVisualizationByZoom,
  ClusterPopupContent,
  ClusterPopupContext
} from "./services/object-manager.js";
export type { RemoteObjectLoadContext, RemoteObjectLoader, RemoteObjectManagerOptions } from "./services/remote-object-manager.js";
export type { PointObjectManagerOptions, UnifiedObjectManagerOptions } from "./services/object-manager-factory.js";
export type { SpatialId, SpatialRecord } from "./services/spatial-grid-index.js";
export type { TrafficLayerOptions, TrafficState } from "./services/traffic-layer.js";
export type { SearchAdapter, SearchContext, SearchResult, SearchProviderSource, SearchProviderOptions } from "./services/search.js";
export type { RouteResult, RouteWaypoint, RoutingContext, RoutingLayerOptions, RoutingProvider } from "./services/routing.js";
export type { SuggestOptions, SuggestContext, SuggestFetcher, SuggestWidgetOptions } from "./services/suggest.js";
export type { WebGLPointInput, WebGLPointDataOptions, WebGLPointAsyncDataOptions, WebGLPointLayerOptions, WebGLPointLayerStats } from "./layers/webgl-point-layer.js";
export type { WebGLSymbolInstance, WebGLSymbolLayerOptions } from "./layers/webgl-symbol-layer.js";
export type { StyledPathInput, StyledPathStyle, WebGLStyledPathBatchOptions } from "./layers/webgl-styled-path-batch.js";
export type { PathBatch, PathBatchMode, PathBatchOptions, UniformPathBatchOptions, FeaturePathBatchOptions } from "./layers/path-batch.js";
export type { PolygonBatchInput, PolygonBatchStyle, WebGLPolygonBatchOptions } from "./layers/webgl-polygon-batch.js";
export type { WebGLPathBatchOptions } from "./layers/webgl-path-batch.js";
export type {
  HeatLayerOptions,
  HeatAsyncDataOptions,
  HeatLayerStats,
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
  PrefetchTileLayerOptions
} from "./services/offline-cache.js";
export type { PerformanceInspectorOptions, PerformanceSnapshot } from "./services/performance.js";
export type { OrihonElementOptions, MapAdapter } from "./services/framework-adapters.js";
