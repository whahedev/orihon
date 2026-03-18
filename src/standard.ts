export * from "./core.js";
export { LayerGroup, FeatureGroup, featureGroup } from "./layer-group.js";
export { Renderer } from "./renderer.js";
export { WMSTileLayer, wmsTileLayer } from "./layers/wms-tile-layer.js";
export { WMTSTileLayer, wmtsTileLayer, createWMTSFromCapabilities } from "./layers/wmts-tile-layer.js";
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

export type { RendererOptions } from "./renderer.js";
export type { WMSParameterValue, WMSTileLayerOptions } from "./layers/wms-tile-layer.js";
export type { WMTSTileLayerOptions, WMTSCapabilitiesConfig } from "./layers/wmts-tile-layer.js";
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
