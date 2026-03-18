import {
  type Orihon, type LatLng, type LatLngLike, type Point, type Polyline,
  type Circle, type Popup, type Tooltip, type ImageOverlay, type VideoOverlay,
  type SVGOverlay, type TextLayer, type TileLayer, type VectorTileLayer,
  type HeatLayer, type HeatFeature, type WebGLPointLayer, type WebGLPointInput,
  type WebGLSymbolLayer, type WebGLSymbolInstance, type TrafficLayer,
  type TileLayerEventMap, type EventFor, type EventHandler, type FeatureGroup,
  type GPUTileLayerEventMap, type GeoJSONLayer
} from "orihon";
import type { TileLayerEventMap as CoreTiles } from "orihon/core";
import type { PathEventMap, MediaOverlayEventMap, ImageOverlayEventMap,
  VideoOverlayEventMap, DivOverlayEventMap, OverlayLifecycleEventMap,
  TextLayerEventMap } from "orihon/standard";
import type { GPUTileLayer, GPUTileLayerEventMap as GpuEvents } from "orihon/webgpu";

declare const map: Orihon;
declare const path: Polyline;
declare const circle: Circle;
declare const popup: Popup;
declare const tooltip: Tooltip;
declare const image: ImageOverlay;
declare const video: VideoOverlay;
declare const svg: SVGOverlay;
declare const text: TextLayer;
declare const tiles: TileLayer;
declare const gpu: GPUTileLayer;
declare const vector: VectorTileLayer;
declare const heat: HeatLayer;
declare const points: WebGLPointLayer;
declare const symbols: WebGLSymbolLayer;
declare const traffic: TrafficLayer;
declare const group: FeatureGroup;
declare const geojson: GeoJSONLayer;

path.on("click", (event) => {
  const target: Polyline = event.target;
  const position: LatLng = event.latlng;
  const original: MouseEvent | PointerEvent = event.originalEvent;
});
circle.once("mouseover", (event) => { const original: PointerEvent = event.originalEvent; });
const pathListener: EventHandler<EventFor<PathEventMap, "mouseout", Polyline>> = () => {};
path.on("mouseout", pathListener).off("mouseout", pathListener);
// @ts-expect-error The callback cannot override a literal event's position type.
path.on("click", (event: { type: "click"; latlng: string }) => {});
popup.on("open", (event) => { const owner: Orihon = event.map; });
popup.on("close", (event) => {
  const owner: Orihon | null = event.map;
  // @ts-expect-error onRemove can also be called while detached.
  const required: Orihon = event.map;
});
tooltip.on("close", (event) => { const target: Tooltip = event.target; });
popup.on("contenterror", (event) => {
  const error: unknown = event.error;
  // @ts-expect-error User content factories may throw non-Error values.
  const message: string = event.error.message;
});
map.on("popupopen", (event) => { const layer: Popup = event.popup; });
map.on("tooltipclose", (event) => { const layer: Tooltip = event.tooltip; });
image.on("error", (event) => { const url: string = event.url; const original: Event = event.originalEvent; });
video.on("error", (event) => {
  const original: Event = event.originalEvent;
  // @ts-expect-error Video errors do not include an image URL.
  const url: string = event.url;
});
svg.on("click", (event) => { const position: LatLng = event.latlng; });
image.on("click", (event) => { const position: LatLng = event.latlng; });
text.on("layout", (event) => { const count: number = event.count; });
tiles.on("tileload", (event) => {
  const x: number = event.x;
  const url: string = event.url;
  const tile: HTMLImageElement | undefined = event.tile;
  // @ts-expect-error The unified tile factory may choose a GPU backend.
  const requiredTile: HTMLImageElement = event.tile;
});
const tileListener: EventHandler<EventFor<CoreTiles, "tileerror", TileLayer>> = () => {};
const rootTileListener: EventHandler<EventFor<TileLayerEventMap, "tileerror", TileLayer>> = tileListener;
tiles.once("tileerror", rootTileListener);
gpu.on("tileload", (event) => {
  const target: GPUTileLayer = event.target;
  const zoom: number = event.z;
  // @ts-expect-error GPU tile events do not provide a DOM image.
  const tile: HTMLImageElement = event.tile;
  // @ts-expect-error Raster tile errors do not promise a caught Error.
  const error: Error = event.error;
});
const gpuListener: EventHandler<EventFor<GPUTileLayerEventMap, "tileabort", GPUTileLayer>> = () => {};
const addonListener: EventHandler<EventFor<GpuEvents, "tileabort", GPUTileLayer>> = gpuListener;
gpu.on("tileabort", addonListener);
vector.on("tileload", (event) => {
  const signal: AbortSignal = event.coordinates.signal;
  const type: "Feature" = event.features[0].type;
  // @ts-expect-error Vector coordinates are nested, unlike raster coordinates.
  const x: number = event.x;
});
vector.on("tileerror", (event) => { const error: unknown = event.error; });
heat.on("click", (event) => {
  const feature: HeatFeature = event.feature;
  const position: LatLng = event.latlng;
  const x: number = event.containerPoint.x;
  // @ts-expect-error This is a plain screen point, not a Point class instance.
  const point: Point = event.containerPoint;
});
heat.on("hover", (event) => {
  const feature: HeatFeature | null = event.feature;
  // @ts-expect-error Hover-out has a null position.
  const position: LatLng = event.latlng;
});
heat.on("mouseout", (event) => {
  const previous: HeatFeature = event.feature;
  const position: LatLng | null = event.latlng;
});
heat.on("select", (event) => { const selected: HeatFeature = event.data; });
heat.on("rebuild", (event) => { const rings: number = event.stats.rings; });
points.on("click", (event) => {
  const position: LatLngLike = event.latlng;
  const data: WebGLPointInput | undefined = event.data;
  // @ts-expect-error Packed data has no per-point input object.
  const requiredData: WebGLPointInput = event.data;
  // @ts-expect-error Coordinates are plain objects, not LatLng class instances.
  const instance: LatLng = event.latlng;
});
points.on("hover", (event) => {
  const data: WebGLPointInput | null | undefined = event.data;
  // @ts-expect-error No hit has a null screen position.
  const x: number = event.containerPoint.x;
});
symbols.on("click", (event) => { const data: WebGLSymbolInstance = event.data; });
traffic.on("statechange", (event) => { const state: "idle" | "loading" | "ready" | "error" = event.state; });
traffic.on("tileload", (event) => { const url: string = event.url; });
// Group children and GeoJSON pointToLayer can supply arbitrary event shapes.
group.on("click", (event) => {
  // @ts-expect-error A group does not guarantee a common child payload.
  const position: LatLng = event.latlng;
});
geojson.on("click", (event) => {
  // @ts-expect-error Custom GeoJSON renderers may not emit a geographic position.
  const position: LatLng = event.latlng;
});
