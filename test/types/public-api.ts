import {
  GeometryWorkerError,
  createGeometryWorkerPool,
  createMapAdapter,
  tileLayer,
  type IdentifiedGeoJSONFeature,
  type MapUpdateOptions,
  type PrefetchTileLayerOptions,
  type RasterTileLayer
} from "../../src/index.js";
import { featureSource } from "../../src/feature-source.js";
import { DrawHandler, drawControl } from "../../src/draw/index.js";
const draw = new DrawHandler();
draw.remove().destroy();
const drawToolbar = drawControl();
drawToolbar.remove().destroy();
const drawDestroyed: boolean = draw.isDestroyed;
void drawDestroyed;
// @ts-expect-error Destructive removal options were replaced by explicit group clearing.
draw.remove({ destroyFeatures: true });
// @ts-expect-error DrawControl follows the same non-destructive remove contract.
drawToolbar.remove({ destroyFeatures: true });
// @ts-expect-error Draw mode may only change through setMode().
draw.mode = "point";
// @ts-expect-error Draw attachment is read-only.
draw.map = null;
// @ts-expect-error Destroyed state cannot be reset.
drawToolbar.isDestroyed = false;

const ownedPool = createGeometryWorkerPool({ useWorker: false });
ownedPool.destroy();

const workerError: Error = new GeometryWorkerError("worker failed", { cause: new Error("root cause") });
void workerError;

const raster: RasterTileLayer = tileLayer("https://example.test/{z}/{x}/{y}.png", { renderer: "dom" });
raster.setUrl("https://example.test/b/{z}/{x}/{y}.png", { redraw: false });
void raster.rendererKind;

const adapter = createMapAdapter("map", { center: { lat: 1, lng: 2 }, zoom: 3 });
const mapUpdate: MapUpdateOptions = { zoom: 4, behaviors: { drag: false } };
adapter.update(mapUpdate);
// @ts-expect-error Adapter update only accepts center/zoom/behaviors.
adapter.update({ locale: "ru" });
adapter.destroy();

const identified: IdentifiedGeoJSONFeature = {
  type: "Feature",
  id: "truck-1",
  geometry: { type: "Point", coordinates: [37.62, 55.75] },
  properties: {}
};
featureSource(identified);
const anonymousFeature = {
  type: "Feature" as const,
  geometry: { type: "Point" as const, coordinates: [37.62, 55.75] },
  properties: {}
};
// @ts-expect-error FeatureSource requires IdentifiedGeoJSONFeature with id.
featureSource(anonymousFeature);

const boundsPrefetch: PrefetchTileLayerOptions = {
  bounds: [{ lat: 55.7, lng: 37.5 }, { lat: 55.8, lng: 37.7 }],
  zooms: [10, 11]
};

const explicitRangePrefetch: PrefetchTileLayerOptions = {
  xRange: [600, 610],
  yRange: [300, 310],
  zooms: [10]
};

// @ts-expect-error Explicit prefetch ranges require both axes when bounds are absent.
const missingYRange: PrefetchTileLayerOptions = {
  xRange: [600, 610],
  zooms: [10]
};

void boundsPrefetch;
void explicitRangePrefetch;
void missingYRange;

// @ts-expect-error The library-managed shared worker is not part of the package API.
import { getSharedGeometryWorkerPool } from "../../src/index.js";
void getSharedGeometryWorkerPool;

import { marker, createMap, fromGeoJSONPosition, toGeoJSONPosition, type LatLngLike, type ManagedGeometry } from "../../src/index.js";
const geoJSONPosition: [number, number] = [37.618423, 55.751244];
marker(fromGeoJSONPosition(geoJSONPosition));
const namedPosition: LatLngLike = { lat: 55.751244, lng: 37.618423 };
const roundTrip: [longitude: number, latitude: number] = toGeoJSONPosition(namedPosition);
void roundTrip;
// @ts-expect-error GeoJSON tuples must pass through the explicit converter.
marker(geoJSONPosition);
// @ts-expect-error Bare latitude-first tuples are no longer accepted either.
createMap("map", { center: [55.751244, 37.618423] });
const managedPoint: ManagedGeometry = { type: "Point", coordinates: geoJSONPosition };
// @ts-expect-error ObjectManager GeoJSON cannot silently become a latitude-first marker.
marker(managedPoint.coordinates);

import { circle, circleMarker, objectManager, type CircleRadius, type RouteResult, type WebGLSymbolInstance } from "../../src/index.js";
const radius: CircleRadius = { radiusMapUnits: 10 };
circle(namedPosition, radius).setRadius({ radiusMeters: 100 });
circle(namedPosition, { radiusMeters: 50 }).setRadiusMeters(75).getRadiusMeters();
circle(namedPosition, { radiusMapUnits: 4 }).setRadiusMapUnits(6).getRadiusMapUnits();
circleMarker(namedPosition, { radiusPixels: 12 }).setRadiusPixels(10);
objectManager({ clusterRadiusPixels: 50 }).setClusterRadiusPixels(60);
const camera = createMap("map", { zoomAnimationDurationMs: 250 });
camera.flyTo(namedPosition, 5, { durationMs: 1000 });
// @ts-expect-error Bare radii have no unambiguous unit.
circle(namedPosition, 100);
// @ts-expect-error Radius units are mutually exclusive.
circle(namedPosition, { radiusMeters: 10, radiusMapUnits: 10 });
// @ts-expect-error Pixel radius uses an explicit name.
circleMarker(namedPosition, { radius: 10 });
// @ts-expect-error Camera durations no longer accept seconds through duration.
camera.flyTo(namedPosition, 5, { duration: 1 });
// @ts-expect-error Camera default is now milliseconds.
createMap("map", { zoomAnimationDuration: 0.25 });
// @ts-expect-error Cluster option denotes a pixel radius, not grid size.
objectManager({ clusterGridSize: 50 });
// @ts-expect-error Route duration is explicitly milliseconds.
const oldRoute: RouteResult = { coordinates: [], duration: 10 };
// @ts-expect-error GPU symbol motion also uses milliseconds.
const oldMotion: Partial<WebGLSymbolInstance> = { startTime: 1, duration: 2 };
void oldRoute;
void oldMotion;

import { createSuggestProvider, routingLayer } from "../../src/index.js";
const suggestions = createSuggestProvider(async (_query, context) => {
  const signal: AbortSignal | undefined = context.signal;
  void signal;
  return ["result"];
});
const routing = routingLayer({ provider: () => [] });
const signal = new AbortController().signal;
const suggestionResult: Promise<string[]> = suggestions.suggest("query", { signal });
const routeResult: Promise<RouteResult[]> = routing.route([namedPosition, namedPosition], { signal });
// @ts-expect-error Request ownership is private; callers use cancel() or AbortSignal.
suggestions._pending;
// @ts-expect-error The active request controller is no longer writable public state.
routing._controller;
void suggestionResult;
void routeResult;

import type { ManagedObject, RemoteObjectReloadOptions } from "../../src/index.js";
const remote = objectManager({ loader: () => [] });
const reloadOptions: RemoteObjectReloadOptions = { signal };
const reloaded: Promise<ManagedObject[]> = remote.reload(reloadOptions);
// @ts-expect-error Reload is a Promise, no longer a chainable scheduling call.
remote.reload().addTo(camera);
// @ts-expect-error Remote request controllers are private lifecycle state.
remote._controller;
void reloaded;

const localManager = objectManager();
localManager.detach().addTo(camera).removeObjects([1, 2]);
const destroyed: boolean = localManager.isDestroyed;
// @ts-expect-error Ambiguous removal was removed; use detach() or removeObjects().
localManager.remove();
// @ts-expect-error The remote subtype uses the same unambiguous lifecycle API.
remote.remove(1);
// @ts-expect-error Terminal state is read-only.
localManager.isDestroyed = false;
void destroyed;

import { icon, type Icon, type DivIcon, type MarkerOptions, type ObjectManager as LocalManager, type RemoteObjectManager, type MarkerCollection, type UnifiedObjectManagerOptions } from "../../src/index.js";
import { createMap as createEasyMap, type EasyMarkerOptions } from "../../src/easy-entry.js";
import type { MarkerProps } from "../../src/react/layers.js";
const imageIcon: Icon = icon({ iconUrl: "pin.png" });
const textIcon: DivIcon = icon({ content: "" });
marker(namedPosition, { icon: imageIcon });
marker(namedPosition, { content: 0 }).setContent("").setIcon(null).setAppearance({ shape: "circle" });
const mixedMarker = { icon: imageIcon, content: "hidden" };
// @ts-expect-error Mixed modes are rejected even through a pre-existing variable.
marker(namedPosition, mixedMarker);
// @ts-expect-error Built-in appearance cannot be hidden behind an icon.
const mixedAppearance: MarkerOptions = { icon: imageIcon, color: "red" };
// @ts-expect-error Icon owns its anchor.
  marker(namedPosition, { icon: imageIcon, anchor: [1, 2] });
// @ts-expect-error Null is not a visual selector; use setIcon(null) to reset a live marker.
marker(namedPosition, { icon: null });
const liveMarker = marker(namedPosition);
// @ts-expect-error Options are a read-only snapshot; mutate through setters.
liveMarker.options.opacity = 0.5;
liveMarker.setOpacity(0.5);
const legacyHtml = { html: "old", title: "title" };
// @ts-expect-error Legacy html is forbidden on variables too.
marker(namedPosition, legacyHtml);
// @ts-expect-error setAppearance cannot silently store custom content.
marker(namedPosition).setAppearance(mixedMarker);
const mixedIcon = { iconUrl: "pin.png", content: "hidden" };
// @ts-expect-error Factory overloads must not accept the other mode through structural typing.
icon(mixedIcon);
// @ts-expect-error DivIcon cannot silently ignore image-only options.
icon({ content: "text", shadowUrl: "shadow.png" });
// @ts-expect-error React preserves the full mutually exclusive union.
const mixedReactMarker: MarkerProps = { position: namedPosition, ...mixedMarker };
// @ts-expect-error Easy keeps exclusivity and nests built-in visuals under appearance.
const mixedEasyMarker: EasyMarkerOptions = { position: namedPosition, ...mixedMarker };
const easy = createEasyMap("map");
// @ts-expect-error Easy rejects flat color beside icon.
easy.addMarker({ position: namedPosition, icon: imageIcon, color: "red" });
// @ts-expect-error Easy object form keeps visual exclusivity.
easy.addMarker({ position: namedPosition, ...mixedMarker });
const localResult: LocalManager = objectManager();
const remoteResult: RemoteObjectManager = objectManager({ loader: () => [] });
const pointResult: MarkerCollection = objectManager({ points: [namedPosition] });
const conflictingManager = { loader: () => [], points: [namedPosition] };
// @ts-expect-error Local fallback cannot swallow conflicting remote/point selectors.
objectManager(conflictingManager);
// @ts-expect-error The exported union itself enforces the same constraint.
const mixedManagerOptions: UnifiedObjectManagerOptions = conflictingManager;
// @ts-expect-error Invalid loader types cannot fall back to local mode.
objectManager({ loader: "url", clusterize: true });
// @ts-expect-error Remote-only options require a loader.
objectManager({ debounceMs: 10 });
// @ts-expect-error Reactive source and remote loader cannot compete for the same store.
objectManager({ loader: () => [], source: { getSnapshot: () => ({ version: 0, features: [] }), subscribe: () => () => {} } });
// @ts-expect-error Point collections cannot silently ignore local clustering options.
objectManager({ points: [], clusterize: true });
declare const selectedManagerOptions: UnifiedObjectManagerOptions;
const selectedManager: LocalManager | RemoteObjectManager | MarkerCollection = objectManager(selectedManagerOptions);
void [textIcon, mixedAppearance, mixedReactMarker, mixedEasyMarker, localResult, remoteResult, pointResult, mixedManagerOptions, selectedManager];
