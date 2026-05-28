<p align="center">
  <img src="../assets/brand/svg/orihon-logo-horizontal.svg" alt="Orihon — folded map and route logo" width="520" />
</p>

# Orihon API

**Every public command, grouped by what you are trying to do, with a runnable line for each.**

This is the reference. If you are drawing your first map, start with the [README](../README.md) and the [Easy API guide](./EASY.md); come back here when you need the exact command.

Each table lists the command, the entry point it is imported from, and what it does. The smallest entry that contains a symbol is the one shown — `orihon` re-exports everything below it, so an import from `orihon` always works too.

```js
import { createMap, tileLayer } from "orihon/core";      // map + basemap
import { marker, geoJSON, polyline } from "orihon/standard";  // everyday GIS
import { objectManager, heatLayer } from "orihon";       // large data, GPU
```

## Contents

- [Create a map](#create-a-map) · [Move the camera](#move-the-camera) · [Read the map](#read-the-map)
- [Coordinates](#coordinates) · [Bounds and projection](#bounds-and-projection)
- [Basemaps and raster tiles](#basemaps-and-raster-tiles) · [Vectors and GeoJSON](#vectors-and-geojson)
- [Markers, popups and tooltips](#markers-popups-and-tooltips) · [Controls](#controls) · [Events](#events)
- [Reactive data](#reactive-data) · [Large datasets](#large-datasets) · [GPU rendering](#gpu-rendering) · [Heat and isolines](#heat-and-isolines)
- [Search, routing and traffic](#search-routing-and-traffic) · [Drawing](#drawing) · [Vector tile formats](#vector-tile-formats)
- [Offline, diagnostics and adapters](#offline-diagnostics-and-adapters) · [React](#react) · [Localization](#localization)
- [Errors and lifecycle](#errors-and-lifecycle)

## Create a map

```js
import { createMap, tileLayer } from "orihon/core";
import "orihon/orihon.css";

const map = createMap("map", { center: { lat: 52.52, lng: 13.405 }, zoom: 12 });

tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors"
}).addTo(map);
```

`createMap(container, options)` takes a container id or an `HTMLElement`. The container needs a height of its own; without one the map prints a warning and nothing is drawn. See [Troubleshooting](./TROUBLESHOOTING.md#zero-size-container).

| Option | Default | What it does |
| --- | --- | --- |
| `center` | `{ lat: 0, lng: 0 }` | Starting coordinate |
| `zoom` | `0` | Starting zoom level |
| `minZoom` / `maxZoom` | engine limits | Clamp the zoom range |
| `zoomSnap` | `1` | Rounding applied to interactive zoom |
| `wheelZoomStep` | — | Zoom change per wheel notch |
| `maxBounds` | `null` | Restrict panning to an area |
| `maxBoundsViscosity` | `0` | How hard the edge of `maxBounds` pushes back |
| `inertia` | `true` | Keep panning after the pointer is released |
| `inertiaDeceleration` / `inertiaMaxSpeed` | — | Tune that glide |
| `zoomAnimationDurationMs` | `250` | Camera animation length; `0` jumps |
| `controls` | `true` | Add zoom, scale and attribution controls |
| `keyboard` / `keyboardPanDelta` | `true` | Keyboard panning |
| `locale` | `"en"` | UI language, see [Localization](#localization) |
| `ariaLabel` | locale default | Accessible name of the map element |
| `behaviors` | all on | Enable or disable individual interactions |
| `crs` | Web Mercator | `"Simple"` for non-geographic scenes |

## Move the camera

| Command | Entry | What it does |
| --- | --- | --- |
| `map.setView(center, zoom)` | core | Jump to a view and settle there |
| `map.updateView(center, zoom)` | core | Same, but part of a gesture still in progress |
| `map.panTo(center)` | core | Keep the zoom, change the centre |
| `map.panBy(offset)` | core | Move by screen pixels |
| `map.setZoom(zoom)` | core | Zoom around the centre |
| `map.zoomIn()` / `map.zoomOut()` | core | One step |
| `map.setZoomAround(anchor, zoom)` | core | Zoom keeping a screen point fixed |
| `map.fitBounds(bounds, options)` | core | Fit an area into the viewport |
| `map.flyTo(center, zoom, options)` | core | Animated move |
| `map.flyToBounds(bounds, options)` | core | Animated fit |
| `map.fitWorld()` | core | Show the whole world |
| `map.panInsideBounds(bounds, options)` | core | Nudge the view back inside an area |
| `map.setMinZoom(zoom)` / `map.setMaxZoom(zoom)` | core | Narrow the zoom range at runtime |
| `map.setMaxBounds(bounds)` | core | Restrict panning at runtime |
| `map.stop()` | core | Cancel a running animation |

```js
map.setView({ lat: 52.52, lng: 13.405 }, 14);
map.fitBounds(route, { padding: 40, animation: "fly", durationMs: 600 });
```

`setView` ends the current camera gesture; `updateView` leaves it open, which is what a drag handler or a live cursor wants. Animation is opt-in: `animation: "fly"` on `fitBounds` / `panInsideBounds`, or `flyTo` / `flyToBounds` directly.

## Read the map

Live state is read-only. Every getter returns a value you can keep; changing it does not move the map.

| Command | What it returns |
| --- | --- |
| `map.getCenter()` | Current centre as a frozen `LatLng` |
| `map.getZoom()` | Current zoom |
| `map.getBounds()` | Visible area as `LatLngBounds` |
| `map.getSize()` | Viewport size in CSS pixels |
| `map.getCamera()` | Immutable snapshot of centre, zoom, size and pixel origin |
| `map.getContainer()` | The container element |
| `map.getMaxBounds()` | Current panning restriction, or `null` |
| `map.isAnimating` | Whether a camera animation is running |
| `map.isDestroyed` | Whether `destroy()` has been called |
| `map.options` | Read-only view of the options the map was built with |
| `map.layers` / `map.controls` | Read-only views of what is attached |
| `map.latLngToContainerPoint(latlng)` | Screen position of a coordinate |
| `map.containerPointToLatLng(point)` | Coordinate under a screen position |
| `map.latLngToLayerPoint(latlng)` | Position in layer space |
| `map.query(point)` / `map.queryLatLng(latlng)` | Hit-test every interactive layer |
| `map.distance(a, b)` | Metres between two coordinates |
| `map.invalidateSize()` | Re-read the container size after a manual layout change |
| `map.exportPng(options)` | Render the current view to a PNG |
| `map.print()` | Open the browser print dialog with the map laid out |
| `map.destroy()` | Release DOM, listeners and GPU resources |

## Coordinates

Geographic coordinates are named values: `{ lat, lng }`. A bare `[a, b]` pair is refused, because the same shape means latitude-first in Leaflet and longitude-first in GeoJSON.

| Command | Entry | What it does |
| --- | --- | --- |
| `latLng(lat, lng)` | core | Build one coordinate, latitude first |
| `lngLat(lng, lat)` | core | Build one coordinate, longitude first |
| `latLngs(list)` | core | Convert a whole list, latitude first |
| `lngLats(list)` | core | Convert a whole list, longitude first |
| `fromGeoJSONPosition(position)` | core | One GeoJSON `[lng, lat]` position |
| `fromGeoJSONPositions(coordinates)` | core | A GeoJSON `coordinates` array |
| `toGeoJSONPosition(latlng)` | core | Back to a GeoJSON `[lng, lat]` pair |

```js
polyline(latLngs([[52.51, 13.37], [52.53, 13.41], [52.50, 13.44]]));
polyline(lngLats(maplibreCoordinates));
polyline(fromGeoJSONPositions(feature.geometry.coordinates));
```

`latLngs()` and `lngLats()` also read a flat run of numbers, including a `Float64Array` straight from a worker: `latLngs([52.51, 13.37, 52.53, 13.41])`. An odd length throws instead of shifting every later point by one place.

`LatLng` is frozen. Read `latlng.lat` and `latlng.lng`; build a changed coordinate with `new LatLng(...)` or `clone()`.

## Bounds and projection

| Command | Entry | What it does |
| --- | --- | --- |
| `bounds(a, b)` | core | Geographic box from two corners, a list of coordinates, or `{ south, west, north, east }` |
| `point(x, y)` | core | Screen or world pixel point — tuples are fine here, `[x, y]` is unambiguous |
| `pointBounds(a, b)` | core | Pixel-space box |
| `distance(a, b)` | core | Shortest geodesic distance in metres |
| `destination(from, metres, bearing)` | core | Coordinate at a distance and bearing |
| `geodesicInterpolate(a, b, stepMetres)` | core | Densify a long line so it follows the curve of the earth |
| `bufferPoint(center, radiusMeters)` | geo | Geodesic circle as a GeoJSON polygon |
| `project(latlng, zoom)` | core | Coordinate to Web Mercator world pixels |
| `unproject(point, zoom)` | core | World pixels back to a coordinate |
| `zoomForBounds(size, bounds, padding)` | core | Largest zoom at which an area still fits |
| `metersToPixels(metres, lat, zoom)` | core | Real distance in screen pixels |
| `scale(zoom)` | core | World width in pixels at a zoom level |
| `clampLat(lat)` | core | Clamp to what Web Mercator can show |
| `wrapLng(lng)` | core | Wrap into −180°…180° |

## Basemaps and raster tiles

| Command | Entry | What it does |
| --- | --- | --- |
| `tileLayer(url, options)` | core | Raster basemap from an `{z}/{x}/{y}` template |
| `wmsTileLayer(url, options)` | standard | OGC WMS source |
| `wmtsTileLayer(template, options)` | standard | OGC WMTS REST source |
| `createWMTSFromCapabilities(xml)` | standard | Build that configuration from a GetCapabilities document |
| `createPMTilesRasterSource(url)` | pmtiles | Raster tiles from a single PMTiles archive |
| `wTinyLfu(capacity)` | orihon | Cache admission policy used by the tile pipeline |

```js
tileLayer("/tiles/{z}/{x}/{y}.png");                       // DOM renderer, the stable default
tileLayer("/tiles/{z}/{x}/{y}.png", { renderer: "auto" }); // WebGPU, then WebGL, then DOM
tileLayer("/tiles/{z}/{x}/{y}.png", { renderer: "webgl" }); // required; throws if unavailable
```

Naming `"webgl"` or `"webgpu"` is a requirement, not a preference: an unsupported or unregistered backend throws `UnsupportedCapabilityError` instead of silently drawing something else. `layer.getStats()` reports active, retained, cached and loading tiles.

Layer methods: `setUrl(template)`, `setOpacity(opacity)`, `redraw()`, `getStats()`, plus `addTo(map)` and `remove()`.

## Vectors and GeoJSON

| Command | Entry | What it does |
| --- | --- | --- |
| `geoJSON(data, options)` | standard | Render a Feature, FeatureCollection, geometry or `FeatureSource` |
| `polyline(points, style)` | standard | Line |
| `polygon(rings, style)` | standard | Filled shape, outer ring first |
| `rectangle(bounds, style)` | standard | Axis-aligned box |
| `circle(center, radiusMeters, style)` | standard | Circle measured on the ground |
| `circleMarker(center, style)` | standard | Circle measured in screen pixels |
| `textLayer(features, { text })` | standard | Collision-aware labels |
| `featureGroup(layers)` | standard | Treat several layers as one for events and bounds |
| `vectorTileLayer({ provider, style })` | orihon | Vector tiles through a provider |
| `createMVTProvider(url, options)` | orihon | Mapbox Vector Tile provider |

```js
polygon(latLngs([[52.50, 13.38], [52.54, 13.39], [52.53, 13.45], [52.50, 13.38]]), {
  fill: "#0f766e",
  fillOpacity: 0.2,
  stroke: "#0f766e"
}).addTo(map).bindPopup("District");

textLayer(features, { text: (feature) => String(feature.properties?.name ?? "") }).addTo(map);
```

Style fields are named for what they do: `stroke`, `strokeWidth`, `fill`, `fillOpacity`, `radiusMeters` on `circle`, `radiusPixels` on `circleMarker`.

## Markers, popups and tooltips

| Command | Entry | What it does |
| --- | --- | --- |
| `marker(position, options)` | standard | One marker |
| `icon(options)` | standard | Reusable marker icon |
| `markerShapeMetrics(shape)` | standard | Size and anchor of a built-in marker shape |
| `popup(content, options)` | standard | Standalone popup |
| `tooltip(content, options)` | standard | Standalone tooltip |
| `imageOverlay(url, bounds, options)` | standard | Image pinned to an area |
| `svgOverlay(element, bounds, options)` | standard | SVG pinned to an area |
| `videoOverlay(url, bounds, options)` | standard | Video pinned to an area |
| `sanitizeSvgElement(svg)` | standard | Strip scripts and event attributes before overlaying |

The three media overlays share `setBounds`, `setOpacity`, `setZIndex` and `setRotation`. Rotation is
in clockwise degrees and is painted on top of the box, so `getBounds()` keeps answering with the
same axis-aligned corners whatever the angle:

```js
import { createMap, tileLayer, imageOverlay } from "orihon";

const map = createMap("map", { center: { lat: 52.52, lng: 13.405 }, zoom: 12 });
tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors"
}).addTo(map);

const plan = imageOverlay("floor-plan.png", [
  { lat: 52.51, lng: 13.39 },
  { lat: 52.53, lng: 13.42 }
], { opacity: 0.8, rotation: 17 }).addTo(map);

plan.setRotation(0);
```
| `popupContent(spec, options)` | popup-content | Build popup content from blocks instead of HTML |
| `sanitizePopupHtml(html)` | popup-content | Safe fragment from untrusted HTML |
| `createEChartsPopupRenderer(options)` | popup-content | Chart blocks inside a popup |
| `popupConditionMatches(condition, context)` | popup-content | Evaluate a content condition |

Every interactive layer carries the same popup and tooltip grammar:

```js
marker({ lat: 52.52, lng: 13.405 })
  .bindPopup("Berlin")
  .addTo(map)
  .openPopup();
```

`bindPopup` · `unbindPopup` · `openPopup` · `closePopup` · `togglePopup` · `isPopupOpen` · `getPopup`, and the same seven for tooltips.

## Controls

| Command | Entry | What it does |
| --- | --- | --- |
| `zoomControl(options)` | standard | Zoom buttons |
| `scaleControl(options)` | standard | Scale bar |
| `attributionControl(options)` | standard | Source credits |
| `layersControl(baseLayers, overlays)` | standard | Layer switcher; both are `{ label: layer }` records |
| `geolocationControl(options)` | standard | Locate the visitor |
| `customControl(options)` | standard | Your own element in a map corner |
| `fullscreenControl(options)` | controls | Fullscreen toggle |
| `miniMap(options)` | controls | Overview map |
| `measureControl(options)` | controls | Distance and area measurement |
| `drawControl(options)` | draw | Drawing and editing toolbar |

```js
import { fullscreenControl } from "orihon/controls";

fullscreenControl({ position: "top-right" }).addTo(map);
```

Controls attach and detach like layers: `addTo(map)` and `remove()`. `map.addControl()` / `map.removeControl()` do the same from the map side.

## Events

```js
map.on("moveend", () => console.log(map.getCenter()));
marker.on("click", (event) => console.log(event.latlng));
```

`on(type, handler)` · `once(type, handler)` · `off(type, handler)` · `emit(type, payload)` · `listens(type)`. Handlers are typed by event name, so the payload is known without a cast.

| Group | Events |
| --- | --- |
| Camera | `movestart` `move` `moveend` `zoomstart` `zoom` `zoomend` `resize` |
| Interaction | `click` `boxzoomstart` `boxzoomend` |
| Composition | `layeradd` `layerremove` `attributionchange` |
| Overlays | `popupopen` `popupclose` `tooltipopen` `tooltipclose` |
| Environment | `behaviorchange` `localechange` `locationfound` `locationerror` `unload` |

Interactions can be switched individually: `map.behaviors.disable("scrollWheelZoom")`, `map.behaviors.enable(...)`, `map.behaviors.isEnabled(...)`, and `map.behaviors.states` for a read-only view of all of them.

## Reactive data

One source can drive several renderers, so changing rendering strategy does not mean rewriting application state.

```js
import { featureSource } from "orihon/source";
import { geoJSON } from "orihon/standard";

const source = featureSource();
geoJSON(source).addTo(map);

source.add({ type: "Feature", id: "station-1", geometry: { type: "Point", coordinates: [13.3694, 52.5251] }, properties: {} });
source.update("station-1", { properties: { status: "closed" } });
source.remove("station-1");
source.batch(() => { /* one notification for the whole block */ });

`add` `addMany` `update` `replace` `remove` `clear` `batch` change the data; `get` `has` `size` `version` `getFeatures` `getSnapshot` `toGeoJSON` read it; `subscribe(listener)` returns an unsubscribe function.
```

See [FeatureSource](./FEATURE_SOURCE.md) for the full contract.

## Large datasets

| Command | Entry | What it does |
| --- | --- | --- |
| `objectManager(options)` | orihon | Local manager for tens of thousands to millions of objects |
| `remoteObjectManager({ loader })` | orihon | The same, loading by viewport |
| `markerCollection(points, options)` | orihon | A large set of plain markers |
| `spatialGridIndex(cellSize)` | orihon | Standalone spatial index |
| `buildClusterIndex(request)` | orihon | Build a cluster hierarchy once |
| `queryClusterLayout(index, zoom, minPoints)` | orihon | Query that hierarchy per zoom |
| `buildClusterLayout(request)` | orihon | Both in one call |
| `preparePointBatch(points)` | orihon | Pack points into typed arrays |
| `preparePointBatchAsync(points, options)` | orihon | The same without blocking the main thread |
| `createGeometryWorkerPool(options)` | orihon | Run that packing in workers |

```js
import { objectManager } from "orihon";

const manager = objectManager({ clusterize: true, clusterRenderer: "auto", layoutWorker: "auto" }).addTo(map);

await manager.addAsync(objects, { chunkSize: 10_000, yieldMode: "task", signal: controller.signal });
console.log(manager.getStats());
```

`objectManager()` returns a different class depending on which key you pass — `loader` gives a `RemoteObjectManager`, `points` a `MarkerCollection`, neither a plain `ObjectManager`. Prefer `remoteObjectManager()` and `markerCollection()` by name; mixed configurations are rejected rather than resolved by precedence.

## GPU rendering

| Command | Entry | What it does |
| --- | --- | --- |
| `webglPointLayer(points, options)` | orihon | Large point sets in one draw call |
| `webglSymbolLayer(options)` | orihon | Instanced symbols with rotation and tint |
| `pathBatch(options)` | orihon | Batched lines |
| `webglPolygonBatch(options)` | orihon | Batched filled shapes |

GPU is opt-in and never silent. Core and Standard stay on DOM, SVG and canvas; the Advanced entry adds these layers for workloads where dataset size or continuous camera stress pays for them.

## Heat and isolines

| Command | Entry | What it does |
| --- | --- | --- |
| `heatLayer(points, options)` | orihon | Heatmap, isolines, or both from one scalar field |
| `buildHeat(points, area, options)` | orihon | The same computation without a map layer |
| `heatSupport()` | orihon | What the current browser can accelerate |

```js
const heat = heatLayer(points, { mode: "both", backend: "auto", labels: true, interactive: true }).addTo(map);

heat.bindTooltip(() => {
  const feature = heat.getHoveredFeature();
  return feature ? `${feature.fieldValue?.toFixed(1) ?? ""}` : "";
});
```

`mode` is `"heat"`, `"contours"` or `"both"`; `backend: "auto"` picks WebGPU for heat-only work and WASM for contours, with a deterministic fallback when an accelerator fails.

## Search, routing and traffic

| Command | Entry | What it does |
| --- | --- | --- |
| `searchProvider(items)` | orihon | Search over a local list |
| `createSuggestProvider(fetcher, options)` | orihon | Debounced, cancellable suggestions from any source |
| `createSuggestWidget({ input, provider })` | orihon | Bind that provider to an input element |
| `routingLayer(options)` | orihon | Draw and manage a route |
| `createStraightLineRoutingProvider()` | orihon | Straight-line provider for tests and fallbacks |
| `trafficLayer(options)` | orihon | Traffic overlay |

Providers are plain functions, so an application can supply a local, commercial or test implementation without changing the layer.

## Drawing

| Command | Entry | What it does |
| --- | --- | --- |
| `drawControl(options)` | draw | Toolbar with the drawing modes |
| `drawHandle(map, options)` | draw | Drive drawing without the toolbar |
| `snapLatLng(map, latlng, layers, options)` | draw | Snap a coordinate to nearby geometry |
| `resolveDrawLocale(locale)` | draw | Labels for the drawing UI |

```js
import { drawControl } from "orihon/draw";
import "orihon/draw.css";

const draw = drawControl({ position: "top-left", modes: ["point", "polyline", "polygon"] }).addTo(map);
draw.setMode("polygon");
```

Modes are `point`, `polyline`, `polygon`, `rectangle`, `circle`, `edit`, `delete` and `off`.

## Vector tile formats

| Command | Entry | What it does |
| --- | --- | --- |
| `decodeMVT(bytes, tile, options)` | orihon | Decode a Mapbox Vector Tile to GeoJSON features |
| `createMVTProvider(url, options)` | orihon | Fetch and decode MVT per tile |
| `createPMTilesProvider(url)` | pmtiles | Vector tiles from a PMTiles archive |
| `deserializePMTilesDirectory(bytes)` | pmtiles | Parse a PMTiles directory |
| `findPMTilesEntry(directory, tileId)` | pmtiles | Look up one tile |
| `zxyToTileId(z, x, y)` | pmtiles | Hilbert tile id used by PMTiles |
| `createMLTProvider(url)` | mlt | Vector tiles in MLT |
| `decodeMLT(bytes, tile)` | mlt | Decode MLT to GeoJSON features |
| `decodePackedMLT(bytes, tile)` | mlt | Decode to typed-array columns |
| `encodePackedMLT(tile)` | mlt | Encode those columns back to MLT |
| `looksLikeMLT(bytes)` | mlt | Signature check |

## Offline, diagnostics and adapters

| Command | Entry | What it does |
| --- | --- | --- |
| `offlineTileCache(options)` | orihon | Cache tiles in the browser Cache API |
| `cache.prefetchTileLayer(layer, { bounds, zooms })` | orihon | Warm an area ahead of time |
| `performanceInspector(map)` | orihon | Frame, layer and memory diagnostics |
| `createMapAdapter(map)` | orihon | Framework-agnostic adapter object |
| `defineOrihonElement(options)` | orihon | Register an `<orihon-map>` custom element |

`prefetchTileLayer` refuses a world-wide prefetch: give it `bounds` or explicit `xRange` / `yRange`.

## React

```jsx
import { Map, TileLayer, Marker, Popup } from "orihon/react";

<Map center={{ lat: 52.52, lng: 13.405 }} zoom={12}>
  <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap contributors" />
  <Marker position={{ lat: 52.52, lng: 13.405 }}>
    <Popup>Berlin</Popup>
  </Marker>
</Map>
```

Components: `Map` `TileLayer` `Marker` `Popup` `Tooltip` `GeoJSON` `FeatureGroup` `ObjectManager`. Hooks: `useMap()` for the map instance inside a child, `useMapEvent(type, handler)` for a typed subscription that cleans itself up.

React and React DOM are optional peer dependencies, so applications that do not use React never pull them in. A runnable project lives in [`examples/react`](../examples/react).

## Localization

| Command | Entry | What it does |
| --- | --- | --- |
| `map.setLocale(locale)` | core | Switch the UI language |
| `await map.localeReady` | core | Resolve once the pack has loaded |
| `resolveLocale(locale)` | standard | Read a locale pack |
| `ensureLocalePacks()` | standard | Load the optional packs on demand |
| `registerLocalePacks(packs)` | standard | Add or override strings |
| `resolveDrawLocale(locale)` | draw | Labels for the drawing UI |

```js
registerLocalePacks({ de: { ...resolveLocale("de"), zoomIn: "Näher" } });
map.setLocale("de");
await map.localeReady;
```

## Errors and lifecycle

| Error | Meaning |
| --- | --- |
| `OrihonError` | Base class; carries `code` and a `context` object |
| `UnsupportedCapabilityError` | An explicitly requested backend is unavailable or unregistered |
| `DestroyedError` | The resource is gone; every later call will fail the same way |
| `AbortError` | The operation was cancelled, usually because a newer one replaced it |
| `CRSCompatibilityError` | A layer and the map disagree about the coordinate system |
| `GeometryWorkerError` | A worker failed while preparing geometry |

The distinction that matters day to day: `AbortError` is normal in a search box or a viewport loader and can be ignored; `DestroyedError` means something outlived the map or widget that owned it.

Ownership follows one rule. Layers and controls attach with `addTo(map)` and detach with `remove()`; anything that owns a resource the caller created — the map, worker pools, caches, widgets — is released with a terminal, idempotent `destroy()`.

```js
map.destroy();
console.log(map.isDestroyed); // true
```

## Conventions

- Options objects instead of positional arguments once more than two independent values are involved.
- Units in the name: `durationMs`, `radiusMeters`, `radiusPixels`.
- Live map state is read-only from outside and changes through explicit methods.
- Cancellation is `AbortSignal` in, `AbortError` out.
- GeoJSON keeps its standard longitude-first order; everything else uses named `{ lat, lng }`.

The full set is written down in [API-DESIGN.md](./API-DESIGN.md).

## Where to go next

- [Easy API](./EASY.md) — the map-centric first-map surface
- [Recipes](./RECIPES.md) — task-oriented examples
- [FeatureSource](./FEATURE_SOURCE.md) — shared reactive data
- [Troubleshooting](./TROUBLESHOOTING.md) — blank maps, missing tiles, renderer errors
- [Migrating from Leaflet](./MIGRATION-LEAFLET.md)
- [Developer Guide](../examples/developer-guide) — every function with a runnable example
