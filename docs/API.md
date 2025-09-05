# Orihon API

This reference describes the stable Orihon 1.x surface. Named ESM imports are preferred because consumers can remove unused exports during bundling.

## Map

`createMap(container, options)` and `new Orihon(container, options)` create a map. `container` can be an element or an element id.

Core view methods:

- `setView(center, zoom)`, `panTo(center)`, `panBy(offset)` and `setZoomAround(point, zoom)` update the current view.
- `fitBounds(bounds)`, `fitWorld()`, `flyTo(center, zoom)`, `flyToBounds(bounds)` and `stop()` implement animated and bounded navigation.
- `getCenter()`, `getZoom()`, `getSize()`, `getBounds()` and coordinate conversion methods inspect the view.
- `addLayer(layer)`, `removeLayer(layer)`, `hasLayer(layer)` and `eachLayer(callback)` manage layers.
- `createPane(name)`, `getPane(name)` and `removePane(name)` manage rendering panes.
- `behaviors.enable(name)`, `disable(name)` and `isEnabled(name)` control `drag`, `scrollZoom`, `pinchZoom`, `dblClick` and `boxZoom`.
- `remove()` and `destroy()` release layers, controls, observers and DOM listeners.

Important options include `center`, `zoom`, `minZoom`, `maxZoom`, `maxBounds`, `maxBoundsViscosity`, `zoomSnap`, `inertia`, `keyboard`, `locale` and per-behavior flags.

Map events include `load`, `movestart`, `move`, `moveend`, `zoomstart`, `zoom`, `zoomend`, `resize`, `click`, `dblclick`, `contextmenu`, `pointerdown` and `pointerup`. Pointer events contain `latlng`, `layerPoint`, `containerPoint` and `originalEvent`.

## Geometry

- `Point`, `Bounds`, `LatLng` and `LatLngBounds` are immutable-value-style geometry helpers.
- Factories: `point`, `bounds`, `latLng`, `latLngBounds`.
- Projection: `project`, `unproject`, `scale`, `zoomForBounds`.
- Geography: `distance`, `metersToPixels`, `clampLat`, `wrapLng`.

Latitude is clamped to Web Mercator limits. Longitudes can cross the antimeridian and are normalized only when `wrapLng` is explicitly used.

## Raster Layers

- `tileLayer(url, options)` supports `{z}`, `{x}`, `{y}`, `{s}`, `{r}`, TMS, Retina, `maxNativeZoom`, `bounds`, `noWrap`, request limits and bounded caches.
- `wmsTileLayer(url, options)` supports WMS 1.1.1/1.3.0 and EPSG:3857/EPSG:4326 axis rules.
- `gridLayer(options)` is the extension base for custom tile grids.
- `imageOverlay`, `videoOverlay` and `svgOverlay` position media in geographic bounds.

Tile events are `tileloadstart`, `tileload`, `tileerror`, `tileabort` and `load`. Mutable methods include `setUrl`, `redraw`, `setOpacity`, `setZIndex` and `bringToFront`.

## Vectors And GeoJSON

Factories are `marker`, `polyline`, `polygon`, `rectangle`, `circle`, `circleMarker` and `geoJSON`. Paths share SVG renderers, cull geometry outside the viewport and simplify long lines by zoom.

`geoJSON(data, options)` supports all GeoJSON geometry types plus `style`, `filter`, `pointToLayer` and `onEachFeature`. Use `addData`, `setStyle`, `resetStyle` and `toGeoJSON` to mutate or export the layer.

For large line sets in **Standard**, use `renderer: "canvas"` (or `"auto"`, which batches at ≥250 path features). **WebGL** path batches (`renderer: "webgl"` / Advanced `auto`) are registered only from the full `orihon` entry — Core/Standard stay CPU/DOM.

Layers support `bindPopup`, `bindTooltip`, `openPopup`, `closePopup`, `openTooltip`, `closeTooltip`, `addTo` and `remove`.

`bindPopup(content, options)` accepts:

- Safe text through `string` or `number`.
- A DOM `Node`, including images, videos, forms and application-owned containers.
- A synchronous or async `(context) => content` factory.
- A mountable `{ mount(container, context), unmount?(container, context) }` object. `mount` may return a cleanup function or an object with `destroy()`.

The context contains the overlay, map, geographic anchor, source layer, click event and event data. Cleanup runs on content replacement, popup close and layer destruction. Rejected async factories emit `contenterror`; stale async results are ignored.

See the [Security model](SECURITY.md) for how strings, DOM nodes, SVG sanitization and offline caching interact.

## UI

Controls are created with `zoomControl`, `scaleControl`, `attributionControl`, `geolocationControl`, `layersControl` and `customControl`. Controls support all four corners, ARIA labels and built-in localization (`en` default; also `ru`, `ar`, `tr`, `zh`, `de`, `fr`, `da`, `hi`).

Icons are created with `icon` or `divIcon`. Marker icons, opacity and z-index can be changed without recreating the marker.

## Data And Services

- `objectManager` renders and clusters local feature collections through a spatial grid. Clustering is **hierarchical greedy within a pixel radius** (Leaflet-style; option name `clusterGridSize` means radius in px, default `50`, clamp ≥ `20`). The hierarchy is built once on data change (optionally in a **worker** via `layoutWorker` / `await manager.prepareLayout()`); zoom only queries the index. Layout is pan-stable at integer zoom. Optional **WebGL** draws unclustered points (`clusterRenderer: "dom" | "webgl" | "auto"`); cluster count badges stay DOM with size/color tiers `<10` / `<100` / `≥100` (override via `clusterIcon`). Redraws are rAF-coalesced.
- `remoteObjectManager` requests objects by viewport and cancels stale loads.
- `createSuggestWidget`, search providers, `trafficLayer` and `routingLayer` keep network providers application-defined.
- `webglPointLayer` renders large point arrays on the GPU (precomputed Web Mercator buffer + per-frame uniforms) and supports rotation/pitch transforms.
- `heatLayer` renders canvas heatmaps from weighted `[lat, lng, intensity?]` points.
- `vectorTileLayer` accepts GeoJSON tile providers; `createMVTProvider` adds binary MVT decoding.
- `geometryWorkerPool` prepares point batches off the main thread when workers are available.
- `offlineTileCache` manages Cache Storage and can generate/register a Service Worker.
- `performanceInspector` reports frame, tile, DOM and optional memory statistics.

`ObjectManager.bindPopup((object, id, context) => content)` and `bindClusterPopup((objects, ids, context) => content)` provide collection-aware popup factories. `openPopup(id)` and `closePopup()` support programmatic control. `RemoteObjectManager` inherits the same API.

`GeoJSONOptions.popup` and `popupOptions` bind content per feature and are also forwarded by `VectorTileLayer`. Calling `WebGLPointLayer.bindPopup` enables nearest-point hit testing and provides `event.index` plus the original input through `context.data`.

## Package Entries

Orihon ships three product tiers plus convenience builds:

| Tier | Entry | Includes |
| --- | --- | --- |
| **Core** | `orihon/core` | Map, events, geometry, grid, raster tiles |
| **Standard** | `orihon/standard` | Core + markers, vectors, GeoJSON, popups, overlays, controls, locales |
| **Advanced** | `orihon` | Standard + WebGL, MVT, ObjectManager, routing, traffic, offline, workers, heatmap, adapters |

Also available:

- `orihon/bundle` — single-file complete ESM bundle
- `orihon/global` — standalone IIFE exposing `Orihon` and resolved `OrihonReady`
- `orihon/orihon.css` — required map styles

## Events

`Evented` powers map and layer listeners. The public event shape is `OrihonEvent`.

Public TypeScript declarations are emitted beside every modular ESM entry.
