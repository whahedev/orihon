# Orihon API

This reference describes the stable Orihon 1.x surface. Named ESM imports are preferred because consumers can remove unused exports during bundling.

## Map

`createMap(container, options)` and `new Orihon(container, options)` create a map. `container` can be an element or an element id.

Core view methods:

- `setView(center, zoom)`, `panTo(center)`, `panBy(offset)` and `setZoomAround(point, zoom)` update the current view.
- `fitBounds(bounds)`, `fitWorld()`, `flyTo(center, zoom)`, `flyToBounds(bounds)` and `stop()` implement animated and bounded navigation.
- `getCenter()`, `getZoom()`, `getSize()`, `getBounds()` and coordinate conversion methods inspect the view.
- `addLayer(layer)`, `removeLayer(layer)`, `hasLayer(layer)` and `eachLayer(callback)` manage layers.
- `query(containerPoint, options)` and `queryLatLng(latlng, options)` return renderer-independent hits from topmost to bottommost. Options are `tolerance` (default `8` CSS px), `layers`, `pane` and `limit` (default `1`; use `Infinity` for every hit). A hit exposes `layer`, `latlng`, `source`, and renderer-specific `id`, `index` or `feature` metadata.
- `createPane(name)`, `getPane(name)` and `removePane(name)` manage rendering panes.
- `behaviors.enable(name)`, `disable(name)` and `isEnabled(name)` control `drag`, `scrollZoom`, `pinchZoom`, `dblClick` and `boxZoom`.
- `remove()` and `destroy()` release layers, controls, observers and DOM listeners.
- `exportPng({ pixelRatio, includeControls })` produces a PNG `Blob`; `print(options)` prepares that image in a print window. The exporter is loaded asynchronously on first use, so importing Core or Standard does not put its implementation on the startup path. Export includes loaded raster images, canvases/WebGL canvases, SVG, and image-based markers. Arbitrary marker/control HTML, `DivIcon`, popups and SVG `foreignObject` are never rasterized.

Important options include `center`, `zoom`, `minZoom`, `maxZoom`, `maxBounds`, `maxBoundsViscosity`, `zoomSnap`, `inertia`, `keyboard`, `locale`, `crs` and per-behavior flags. `crs` accepts `CRS.EPSG3857` / `"EPSG:3857"` (default) or `CRS.Simple` / `"Simple"`.

`CRS.Simple` uses Leaflet-compatible map coordinates: `[y, x]`, `x` grows right and `y` grows up. Projection is `x * 2^zoom, -y * 2^zoom`; distance is Euclidean in map units. Tile coordinates still use the normal `{z}/{x}/{y}` grid, so geographic OSM tiles are not meaningful on a Simple map. `fitWorld()` fits `maxBounds` when configured, otherwise `[[0, 0], [256, 256]]`.

Map events include `load`, `movestart`, `move`, `moveend`, `zoomstart`, `zoom`, `zoomend`, `resize`, `click`, `dblclick`, `contextmenu`, `pointerdown` and `pointerup`. Pointer events contain `latlng`, `layerPoint`, `containerPoint` and `originalEvent`.

## Geometry

- `Point`, `Bounds`, `LatLng` and `LatLngBounds` are immutable-value-style geometry helpers.
- Factories: `point`, `bounds`, `latLng`, `latLngBounds`.
- Projection: `project`, `unproject`, `scale`, `zoomForBounds`.
- Geography: `distance`, `destination`, `geodesicInterpolate`, `metersToPixels`, `clampLat`, `wrapLng`.

Latitude is clamped to Web Mercator limits. Longitudes can cross the antimeridian and are normalized only when `wrapLng` is explicitly used.

## Raster Layers

- `tileLayer(url, options)` supports `{z}`, `{x}`, `{y}`, `{s}`, `{r}`, TMS, Retina, `maxNativeZoom`, `bounds`, `noWrap`, request limits and bounded caches. Option `renderer` is `"auto"` (default), `"dom"`, `"webgl"` or `"webgpu"`. Core/Standard always use DOM image tiles unless the app also imports `orihon/webgpu`. The full `orihon` entry registers WebGL and WebGPU backends so `"auto"` uses WebGPU when `navigator.gpu` exists, else WebGL textured quads, else DOM. `"webgl"` / `"webgpu"` fall back to DOM when that GPU path is unavailable (same pattern as GeoJSON). Explicit `webglTileLayer(url, options)` always constructs the WebGL layer. GPU tile layers retain a multi-level texture cache, prefetch toward the edge revealed by drag/inertia, and prepare the next coarser viewport at low priority. Frames are composited coarse-to-fine: a ready parent remains an opaque backstop until each exact tile arrives. CSS camera warping is used only while the warped framebuffer still covers the complete viewport; unsafe zoom-out and pan frames repaint immediately. `getStats()` includes `needed`, `visibleReady`, `preloadNeeded`, `preloadReady`, geometric `coveragePct`, `ready`, `loading`, `cached` and approximate GPU bytes.
- `wmsTileLayer(url, options)` supports WMS 1.1.1/1.3.0 and EPSG:3857/EPSG:4326 axis rules.
- `wmtsTileLayer(template, options)` supports Web Mercator WMTS REST templates with `{TileMatrix}`, `{TileCol}` and `{TileRow}`. `createWMTSFromCapabilities(xml)` extracts the first REST tile resource and its layer/style/matrix-set options. The lab server exposes a live local GetCapabilities document and SVG tile endpoint for an offline-compatible integration example.
- `gridLayer(options)` is the extension base for custom tile grids.
- `imageOverlay`, `videoOverlay` and `svgOverlay` position media in geographic bounds.

Tile events are `tileloadstart`, `tileload`, `tileerror`, `tileabort` and `load`. Mutable methods include `setUrl`, `redraw`, `setOpacity`, `setZIndex` and `bringToFront`.

## Vectors And GeoJSON

Factories are `marker`, `polyline`, `polygon`, `rectangle`, `circle`, `circleMarker` and `geoJSON`. Paths share SVG renderers, cull geometry outside the viewport and simplify long lines by zoom.

`PathOptions` includes `dashArray` (`"8 4"` or `[8, 4]`), `dashOffset`, `lineJoin`, `lineCap`, `geodesic`, `arrow` (`true`, `"start"`, `"end"`, `"both"`) and `arrowSize`. `setStyle({ dashArray: null })` clears a dash. SVG and canvas paths support dash and arrows; WebGL path batches intentionally remain solid. Geographic polylines/polygons with `geodesic: true` are densified along great-circle segments. `circle(center, radius, { geodesic: true })` renders a sampled geographic ring on EPSG:3857; circles on Simple maps use the radius in map units.

Markers accept `rotation` in degrees and `rotationOrigin` as a CSS transform-origin value. Runtime dragging can be toggled without recreating a layer via `marker.setDraggable(boolean)` and inspected with `marker.isDraggable()`.

`geoJSON(data, options)` supports all GeoJSON geometry types plus `style`, `filter`, `pointToLayer` and `onEachFeature`. Use `addData`, `addDataAsync`, `setStyle`, `resetStyle` and `toGeoJSON` to mutate or export the layer. `addDataAsync(input, options)` accepts parsed GeoJSON, a raw JSON `string`/`Blob`, or `AsyncIterable<GeoJSONData>`. Raw data is parsed in a Blob Worker when available; parsed objects are ingested cooperatively without cloning the complete object graph. Options are `chunkSize` (default 5000), `useWorker` (default `true`), `yieldMode` (`"frame"` or `"task"`), `maxBytes` (raw inputs, default 256 MiB), `signal` and `onProgress(processed, total)`. A CSP that rejects Blob workers causes a safe main-thread parse fallback, followed by chunked ingestion.

The WebGL path backend uses camera warping between throttled exact GPU frames and redraws exactly after movement settles. `WebGLPathBatchOptions.cameraRedrawInterval` is the base cadence (250 ms; `0` disables throttling), and `cameraSettleDelay` controls the final redraw delay (120 ms).

`textLayer(features, options)` is available from `orihon/standard`. It renders point or line labels to one canvas with priority-ordered greedy collision, zoom limits, halo, offset and RTL alignment. Required option: `text(feature)`. Use `setData()` to replace features, `rebuild()` after application-owned label inputs change, and `getVisibleLabels()` to inspect the accepted layout.

For large line sets in **Standard**, use `renderer: "canvas"` (or `"auto"`, which batches at ≥250 path features). Canvas batches support feature-aware hit testing, click events and popups; popup factories receive the clicked source feature. **WebGL** path batches (`renderer: "webgl"` / Advanced `auto`) are registered only from the full `orihon` entry — Core/Standard stay CPU/DOM.

Layers support `bindPopup`, `bindTooltip`, `openPopup`, `closePopup`, `openTooltip`, `closeTooltip`, `addTo` and `remove`.

`bindPopup()` and `bindTooltip()` automatically enable interaction on a layer, including a path originally created with `interactive: false`; no extra click handler or Studio-specific bridge is required. A short pointer tap opens the overlay, while a drag that starts on a geometry still pans the map. Closed SVG geometries (`polygon`, `rectangle`, `circle`, `circleMarker`) use their complete interior as the hit area even when `fill: "none"`; polylines use their painted stroke.

`bindPopup(content, options)` accepts:

- Safe text through `string` or `number`.
- A DOM `Node`, including images, videos, forms and application-owned containers.
- A synchronous or async `(context) => content` factory.
- A mountable `{ mount(container, context), unmount?(container, context) }` object. `mount` may return a cleanup function or an object with `destroy()`.

For declarative rich content, the optional `orihon/popup-content` entry exports `popupContent(spec, options)`. It renders responsive text, sanitized HTML, images, autoplay-capable video, conditional blocks and chart hosts while owning their cleanup. Charts stay adapter-based: pass `createEChartsPopupRenderer()` or a custom `chartRenderer`, so the engine never bundles or requires ECharts.

The context contains the overlay, map, geographic anchor, source layer, click event and event data. Cleanup runs on content replacement, popup close and layer destruction. Rejected async factories emit `contenterror`; stale async results are ignored.

See the [Security model](SECURITY.md) for how strings, DOM nodes, SVG sanitization and offline caching interact.

## UI

Controls are created with `zoomControl`, `scaleControl`, `attributionControl`, `geolocationControl`, `layersControl` and `customControl`. Controls support all four corners, ARIA labels and built-in localization (`en` default; also `ru`, `ar`, `tr`, `zh`, `de`, `fr`, `da`, `hi`).

Optional `orihon/controls` exports:

- `fullscreenControl()` uses the Fullscreen API and a fixed-position CSS fallback. Its nine localized enter/exit labels live in the optional controls entry, not in core `OrihonLocale`; `title` / `exitTitle` override them.
- `measureControl()` collects clicks into a live polyline and tooltip. With `geodesic: true` (default), both rendering and segment length are geodesic; `false` uses projected CRS length (map units on `CRS.Simple`). While active, document-level `Enter` finishes and `Escape` clears the measurement, except when the event comes from an editable control. `start()`, `finish()`, `clear()`, `getPoints()` and `getDistance()` are available programmatically.
- `miniMap(layer, { zoomOffset: -4 })` owns a second synchronized map and a parent-viewport rectangle. Supply a fresh layer instance that is not attached elsewhere.
- `graticuleLayer({ step: "auto" })` draws SVG meridians/parallels. On `CRS.Simple`, explicitly pass `units: "map"`.

Icons are created with `icon` or `divIcon`. Marker icons, opacity and z-index can be changed without recreating the marker. `divIcon({ content })` strings are plain text; pass a `Node` for SVG/HTML structure.

## Data And Services

- `objectManager` renders and clusters local feature collections through a spatial grid. Clustering is **hierarchical greedy within a pixel radius** (Leaflet-style; option name `clusterGridSize` means radius in px, default `50`, clamp ≥ `20`). Up to `clusterHierarchyMaxObjects` (default `250000`) the all-zoom hierarchy is built once on data change; larger collections use compact, worker-built layouts only for integer zooms that are actually visited. Set the limit to `0` to force an unlimited hierarchy. `getStats().clusterStrategy` reports `"none"`, `"greedy"`, or `"hierarchy"`. Layout is pan-stable at integer zoom. Optional **WebGL** draws unclustered points (`clusterRenderer: "dom" | "webgl" | "auto"`); cluster count badges stay DOM with size/color tiers `<10` / `<100` / `≥100` (override via `clusterIcon`). Redraws are rAF-coalesced. Optional `maxObjects` caps ingest. `maxVerticesPerGeometry` (default 65536) rejects oversized LineString/Polygon. For **clustered 1M points** use `{ clusterize: true, sceneFeatures: false, styleByCategory: false, clusterRenderer: "webgl" }`; for flat points set `clusterize: false`. In both cases prefer `await manager.addAsync(iterable, { chunkSize:10000, yieldMode:"task", render:false })`, then call `prepareLayout()`.
- Runtime **ObjectState** (`setObjectState` / `setObjectStates` / `getObjectState`) is separate from `ManagedObject.properties`. Data-driven `style(object, state, context)` resolves `color` / `opacity` / `size` for DOM and WebGL; legacy `styleByCategory` remains the default when `style` is unset. Priority: base → legacy palette → custom `style` → normalize. `setSelected` / `setHovered` stay as single-selection convenience APIs over `ObjectState`. WebGL updates patch per-point color/size buffers when possible. `sceneFeatures: false` skips icon/label/trail/path layers and is the 1M fast path; `update` / `{ animate }` still patch GPU points via the spatial index.
- `remoteObjectManager` requests objects by viewport and cancels stale loads.
- `createSuggestWidget`, search providers, `trafficLayer` and `routingLayer` keep network providers application-defined.
- `webglPointLayer` renders large point arrays on the GPU (precomputed Web Mercator buffer + per-frame uniforms) and supports rotation/pitch transforms. Interactive hit-testing uses a mercator spatial hash (linear scan only for small or rotated sets). `setDataAsync()` projects large iterable/async-iterable inputs in private chunks and atomically swaps the completed buffers.
- `heatLayer` / `webglHeatLayer` render heatmaps from weighted `[lat, lng, intensity?]` points. Default color is **geographic density** (mass / kernel area). `webglHeatLayer({ field: "value" })` blends the kernel **mean** toward the **peak** by the local share of alarm-weight mass, so ~2% exceedances stay mostly green while ~20% pull yellow/red. `max` is the value (or overlap, in density mode) that maps to the top of the gradient. ObjectManager `heatmapWeight(object, id)` feeds the value field; the packed 100k–1M path forwards it (explicit zeros stay cool). `setDataAsync()` is the responsive replacement path for large raw arrays. Value-mode kernels clamp to `minRadius` / `maxRadius`. Zoom-in CSS-follows the last paint; zoom-out rebuilds with the same world kernel.
- `vectorTileLayer` accepts GeoJSON tile providers; `createMVTProvider` adds binary decoding (`decodeMVT` defaults: 2 MiB / 16384 features / 8192 string bytes). The Advanced entry routes Mapbox MVT through a WASM geometry decoder when WebAssembly is available, and sniffs Orihon MLT subset 1 so the same `createMVTProvider` / `decodePackedMVT` / `decodeMVT` calls accept `.mlt` tiles. `decodeMVT()` remains the GeoJSON compatibility path. Its optional `paint` array supports source `layer`, geometry `type` (`fill`, `line`, `circle`), zoom limits, a predicate `filter`, and normal path/circle options. A `style` callback overrides `paint` when both are present.
- `geoJSON` accepts optional `maxFeatures`.
- `geometryWorkerPool` prepares point batches off the main thread when workers are available.
- `offlineTileCache` manages Cache Storage and can generate/register a Service Worker. Instance `urlPrefixes` also filter `prefetch()`.
- `performanceInspector` reports frame, tile, DOM and optional memory statistics.

`ObjectManager.bindPopup((object, id, context) => content)` and `bindClusterPopup((objects, ids, context) => content)` provide collection-aware popup factories. `openPopup(id)` and `closePopup()` support programmatic control. Cluster clicks fit member bounds below `clusterMaxZoom` when `zoomToBoundsOnClick` is enabled. At maximum zoom, `spiderfyOnMaxZoom` fans overlapping members into a circle/spiral with connector legs independently of `clusterZoomOnClick`; configure spacing through `spiderfyDistanceMultiplier`, or call `spiderfyCluster(id)` / `unspiderfy()` directly. `RemoteObjectManager` inherits the same API.

### Object state and data-driven styling

`ManagedObject.properties` is durable feature data. `ObjectState` is transient UI/application state stored inside the manager (not copied into `properties`). Scalar values only (`string | number | boolean | null`); nested objects/arrays throw `TypeError`. `undefined` in `setObjectState` deletes a key; `null` is stored.

```js
const manager = objectManager({
  clusterRenderer: "auto",
  style: (object, state, context) => ({
    color:
      context.selected
        ? "#7c3aed"
        : context.hovered
          ? "#f59e0b"
          : state.alarm === true
            ? "#dc2626"
            : object.properties?.status === "offline"
              ? "#64748b"
              : "#16a34a",
    opacity: state.disabled === true ? 0.3 : 0.9,
    size: context.zoom >= 14 ? 13 : 7
  })
});

manager.setObjectState("truck-42", { alarm: true });
manager.setSelected("truck-42");
manager.setObjectStates([
  { id: "truck-42", state: { tracked: true } },
  { id: "truck-7", state: { disabled: true } }
]);
```

Style resolution order: base defaults → legacy `styleByCategory` palette (category / alert / selected / hover) → custom `style` → clamp/normalize. With a custom resolver, selected/hover colors are **not** forced on top — read `context.selected` / `context.hovered` when needed. `setStyle(null)` restores legacy styling. `clear()` drops objects and states but keeps the style resolver. Events: `objectstatechange` (`id`, `state`, `changedKeys`), `stylechange`. In a `setObjectStates` batch, the last `selected: true` / `hovered: true` wins so only one object remains selected or hovered.

### ObjectManager scene APIs

- **Geometries:** legacy `{ coordinates: [lat, lng] }` or `geometry: Point | LineString | Polygon`. Invalid legacy points stay in the store but are not indexed.
- **Icons:** `registerIcon` / `removeIcon` / `hasIcon` / `clearIcons` + `style.icon` / `iconTint` / `rotation`. Atlas rebuilds only when the icon set changes.
- **Labels:** `style.label` (`text`, font, halo, offset, priority, minZoom/maxZoom). `declutter: true` enables label/icon collision; `collisionMode: "always" | "auto" | "hide"`.
- **Visualization:** `visualization: "objects" | "clusters" | "heatmap" | "auto"` with `visualizationByZoom` thresholds; `setVisualization()`. State is preserved across mode switches.
- **Clusters:** `clusterProperties` reducers (`count`/`sum`/`min`/`max`) and optional `clusterStyle` (`containsSelected` metadata included).
- **Search:** `search: { fields }` + `manager.search(query, options)`. Incremental on property changes only.
- **Time:** `time: { value }` or `{ from, to }` + `setTime` / `setTimeRange`. Indexed overlap query; does not mutate `ObjectState`. Flat WebGL (no clusters) compacts the GPU pack by the active range without a full layout rebuild.
- **Motion / trails:** `updateObjects` / `moveObject` with `{ animate, duration }`; `style.trail` history batched into the styled path layer (`maxPoints` clamped to 512).
- **Mass points:** `sceneFeatures: false` + `await addAsync(..., { render:false })` + `setPackedData({ adopt: true })` internally. Do not enable search/time/icons at 1M.
- **Lines / polygons:** `style.line` (`dashArray`, `dashOffset`, `gradient`) and `style.polygon` (`fill`/`stroke`). Hit-testing uses bbox then path distance / point-in-polygon.
- **Events:** `visualizationchange`, `timerangechange`, `iconregister`, `iconremove` (in addition to existing object/state events). Avoids emitting per GPU attribute patch.

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
- `orihon/draw` / `orihon/draw.css` — optional drawing, editing and snapping
- `orihon/react` — React 18+ components and hooks (React/ReactDOM are peer dependencies)
- `orihon/pmtiles` — optional zero-dependency PMTiles v3 reader. `createPMTilesProvider(url, decodeOptions)` feeds vector archives to `vectorTileLayer`; `createPMTilesRasterSource(url)` exposes async `getTile()` / object-URL `getTileUrl()` helpers for raster adapters. Range requests accept the tile provider's abort signal. Tests read the committed `test/fixtures/tiny.pmtiles` archive and decode its embedded MVT feature.
- `orihon/mlt` — MLT **encoder** (`encodePackedMLT`) and a standalone decoder for apps that do not use the Advanced entry. Advanced `createMVTProvider` / `decodePackedMVT` already accept Orihon MLT subset 1 (plain / varint / little-endian vertices, no FastPFOR / FSST / Morton).
- `orihon/mvt-wasm` — standalone WASM MVT geometry decoder for Standard-only apps. Advanced `decodePackedMVT` registers it automatically.
- `orihon/webgpu` — standalone WebGPU raster tiles for Standard-only apps (`import "orihon/webgpu"` then keep using `tileLayer`). Advanced `tileLayer({ renderer: "auto" | "webgpu" })` registers the factory automatically when `navigator.gpu` exists. Node / missing GPU reports `renderer: "none"`.
- `orihon/controls` — optional fullscreen, measurement, mini-map and graticule UI/layers.
- `orihon/geo` — small geography entry with `distance`, `destination`, `geodesicInterpolate` and `bufferPoint`.
- `orihon/popup-content` — declarative rich-popup blocks plus an optional ECharts adapter; no chart library is bundled.

## Events

`Evented` powers map and layer listeners. The public event shape is `OrihonEvent`.

Public TypeScript declarations are emitted beside every modular ESM entry.

## Geo entry

`bufferPoint(center, radiusMeters, { steps, properties })` from `orihon/geo` returns a geodesic GeoJSON Polygon feature. Orihon deliberately does not duplicate Turf. Use Turf for union, difference, simplify and complex buffering, then render its output normally:

```js
import { buffer } from "@turf/buffer";
import { geoJSON } from "orihon/standard";

geoJSON(buffer(featureCollection, 2, { units: "kilometers" })).addTo(map);
```

## Drawing entry

Import `drawControl` or the headless `DrawHandler` from `orihon/draw`, plus `orihon/draw.css` for the toolbar. Point, polyline, polygon, rectangle, circle, edit and delete modes support snapping, `undo()` / `redo()`, `toGeoJSON()` and `loadData()`. Edit mode supports vertex/midpoint handles for paths and markers, plus center/radius handles for circles. Keyboard: `Enter` finish, `Escape` cancel, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Y` or `Ctrl/Cmd+Shift+Z` redo (window-level while a mode is active). Toolbar strings use `resolveDrawLocale` / `DrawLocale` (nine languages, including `drawRedo`); they are not part of core `OrihonLocale`. Pass `locale: "ru"` (etc.) on the control, or call `draw.render()` after `map.setLocale(...)` so titles follow the map. Use `setMode()`, `finish()` and `cancel()` for programmatic control. Removing the control keeps its `featureGroup`; pass `remove({ destroyFeatures: true })` to clear it.

## React entry

`orihon/react` exports `Map`, `TileLayer`, `Marker`, `Popup`, `Tooltip`, `GeoJSON`, `FeatureGroup`, `ObjectManager`, `useMap()` and `useMapEvent()`. The map is created in a layout effect and removed during cleanup. Layer prop changes call mutable Orihon methods instead of recreating the map; ObjectManager diffs `objects` by `id`. Rendering is client-only; SSR map output and React Native are outside this entry.

## Public function and method reference

This section is the compact index of the supported surface. Factory functions use lower camel case and return the corresponding class (`marker()` → `Marker`, `objectManager()` → `ObjectManager`). Factories and classes are equivalent; factories are convenient in JavaScript, while classes are useful for extension and `instanceof` checks.

Coordinates passed to Orihon are `[latitude, longitude]`. GeoJSON coordinates remain the GeoJSON-standard `[longitude, latitude]`. Methods returning `Point`, `LatLng`, `Bounds` or `LatLngBounds` return value objects; mutating a returned value does not reconfigure the map.

### Events and base layers

`Evented` supplies `on(type, handler)`, `once(type, handler)`, `off(type?, handler?)` and `emit(type, payload?)`. Handlers receive an `OrihonEvent` with `type`, `target` and the emitted fields. `off()` without arguments clears all handlers owned by that instance.

Every `Layer` supports the following lifecycle and content methods:

| Method | Result |
| --- | --- |
| `addTo(map)` | Adds the layer and returns it for chaining |
| `remove()` | Detaches it; data/options remain reusable unless the class documents destruction |
| `getPane(name?)` | Returns the configured map pane or `null` |
| `bindPopup(content, options?)` / `unbindPopup()` | Attaches/removes safe popup content |
| `openPopup(latlng?)` / `closePopup()` / `togglePopup()` | Controls a bound popup |
| `isPopupOpen()` / `getPopup()` | Reads popup state |
| `bindTooltip`, `unbindTooltip`, `openTooltip`, `closeTooltip` | Tooltip counterparts |

`LayerGroup` adds `addLayer`, `removeLayer`, `hasLayer`, `clearLayers`, `eachLayer`, `getLayers` and `invoke`. `FeatureGroup` also propagates child events, implements `getBounds()` and forwards `setStyle()`.

### Map creation and camera

`createMap(container, options?)` returns `Orihon`. `container` is an element or element id. Important `MapOptions` include `center`, `zoom`, `minZoom`, `maxZoom`, `maxBounds`, `crs`, `controls`, `locale`, `behaviors`, `inertia`, `zoomSnap` and `zoomDelta`.

| Method | Purpose |
| --- | --- |
| `getCenter()`, `getZoom()`, `getSize()`, `getBounds()`, `getCamera()` | Read current view/camera state |
| `setView(center, zoom?, options?)` | Set center and zoom; `settle:false` defers the terminal move event |
| `panTo`, `panBy`, `setZoom`, `zoomIn`, `zoomOut`, `setZoomAround` | Incremental navigation |
| `fitBounds`, `fitWorld`, `flyTo`, `flyToBounds`, `stop` | Fit/animated navigation |
| `setMaxBounds`, `getMaxBounds`, `panInsideBounds` | Restrict and correct the camera |
| `latLngToLayerPoint`, `latLngToContainerPoint`, `containerPointToLatLng` | Convert geographic and screen coordinates |
| `addLayer`, `removeLayer`, `hasLayer`, `eachLayer` | Manage layers |
| `query(point, options?)`, `queryLatLng(latlng, options?)` | Return top-to-bottom renderer-independent hit results |
| `addControl`, `removeControl` | Manage UI controls |
| `createPane`, `getPane`, `getPanes`, `removePane` | Manage rendering panes |
| `invalidateSize()` | Re-read container dimensions after layout changes |
| `setLocale(locale)` | Replace/merge the instance locale and redraw controls |
| `exportPng(options?)`, `print(options?)` | Safe asynchronous map export/print |
| `remove()` / `destroy()` | Stop animation, detach layers/listeners and release DOM |

`map.behaviors` exposes `enable(name)`, `disable(name)`, `toggle(name, enabled?)`, `isEnabled(name)` and `getEnabled()`. Names are `drag`, `scrollZoom`, `doubleClickZoom`, `touchZoom`, `boxZoom` and `keyboard`.

### Geometry helpers

| Export | Description |
| --- | --- |
| `point`, `bounds`, `pointBounds` | Construct pixel/cartesian value objects |
| `latLng`, `latLngBounds` | Parse geographic tuples/objects and bounds |
| `extendBounds` | Return bounds extended with a point/bounds value |
| `project`, `unproject` | Web Mercator pixel conversion at a zoom |
| `distance` | Great-circle distance in metres |
| `destination` | Destination from origin, bearing and distance |
| `geodesicInterpolate` | Great-circle interpolation between two positions |
| `metersToPixels` | Convert metres to screen pixels for latitude/zoom |
| `clampLat`, `wrapLng` | Normalize Web Mercator latitude/longitude |
| `scale`, `zoomForBounds` | Zoom scale and bounds fitting helpers |
| `TILE_SIZE`, `MAX_LAT`, `EARTH_RADIUS` | Projection constants |

`CRS.EPSG3857` is the normal browser-map CRS; `CRS.Simple` uses cartesian map units. GPU geographic layers throw `CRSCompatibilityError` when used with an incompatible CRS.

### Raster and tile functions

| Factory | Purpose / important options |
| --- | --- |
| `gridLayer(options?)` | Base tiled layer; subclass/override tile creation |
| `tileLayer(template, options?)` | URL/function raster tiles; supports TMS, Retina, bounds, cache limits and `renderer` |
| `webglTileLayer(template, options?)` | Explicit WebGL raster tile renderer |
| `wmsTileLayer(url, options?)` | WMS GetMap requests with version/CRS/parameter handling |
| `wmtsTileLayer(template, options?)` | WMTS KVP or REST-template tiles |
| `createWMTSFromCapabilities(xml, options?)` | Parse capabilities and construct WMTS configuration |

`GridLayer` exposes `getTileSize`, `setOpacity`, `setZIndex`, `bringToFront` and `bringToBack`. `TileLayer` adds `getTileUrl`, `setUrl` and `redraw`. Advanced `tileLayer({ renderer: "auto" })` chooses WebGPU → WebGL → DOM when registered/supported.

### Markers, vectors, GeoJSON and overlays

| Factory | Created object |
| --- | --- |
| `marker(latlng, options?)` | DOM marker with title, built-in appearance or custom `Icon`; `interactive:false` omits pointer listeners |
| `icon(options?)`, `divIcon(options?)` | Image icon / text-or-Node DivIcon |
| `markerCollection(points, options?)` | `dom`: recycled HTML markers; `svg`: every point remains DOM, using lightweight `<circle>` nodes plus spatially distributed HTML Marker buttons; `webgl`; `auto`; or `hybrid` (`domLimit` HTML markers over WebGL). |
| `polyline`, `polygon`, `rectangle`, `circle`, `circleMarker` | Mutable SVG/canvas vector shapes |
| `geoJSON(data, options?)` | Feature group from GeoJSON, with filter/style/renderer/popup hooks; `retainFeatures:false` packs write-once canvas/WebGL paths without retaining source features |
| `canvasBaseLayer(options?)` | Custom single-canvas layer base |
| `textLayer(features, options)` | Batched labels with collision and halo |
| `imageOverlay`, `videoOverlay`, `svgOverlay` | Georeferenced media overlays |

For a large DOM collection with a bounded interactive surface, keep the
priority points as normal Marker buttons and render the remainder as SVG DOM:

```ts
const pointsLayer = markerCollection(points, {
  renderer: "svg",
  htmlButtonLimit: 500,
  // Optional override; otherwise derived from pointSize.
  buttonCellSize: 96,
  marker: { interactive: true, title: "Open object" }
});

pointsLayer.setSelected(selectedObjectIds);
```

This mode does not create a WebGL point layer. `htmlButtonLimit` is a soft
automatic budget, not a fixed partition: the engine distributes buttons over
the current viewport with at least `buttonCellSize` screen pixels between
automatic candidates. `setSelected(indices)` and `setPointSelected(index, state)`
promote user-selected visible objects even above that budget. On camera settle,
entered/exited viewport objects are reassigned while retained Marker/SVG nodes
are reused. Every non-promoted point remains an individually addressable SVG
`<circle>` returned by `getElement(index)`. Set `buttonCellSize: 0` when spatial
thinning is not wanted.
| `popup`, `tooltip` | Standalone `DivOverlay` instances |

Path layers support `setStyle`; geometry-specific setters update coordinates/radius/bounds without recreation. `GeoJSONLayer.addData` incrementally adds data, `addDataAsync` parses/ingests large inputs responsively, and `clearLayers` resets the layer. For million-scale, non-interactive path rendering, create the layer with `renderer:"webgl", interactive:false, retainFeatures:false` and use `await layer.addDataAsync(blobOrData, { chunkSize:5000 })`. This mode keeps only the packed path buffer: `toGeoJSON()` cannot return discarded paths and later per-feature style inspection is unavailable. Point layers are always retained. For untrusted raw data keep `maxBytes` bounded and set `maxFeatures`; for untrusted SVG strings use the default `sanitizeSvgElement` path.

### Controls and locale

Standard factories are `zoomControl`, `scaleControl`, `geolocationControl`, `attributionControl`, `layersControl` and `customControl`. Controls support `addTo`, `remove`, `setPosition`, `getPosition` and `getContainer`. `customControl` accepts text, an application-owned `Node`, or a factory.

`resolveLocale(input)` returns a complete locale; `ensureLocalePacks(names)` loads optional packs; `registerLocalePacks(packs)` extends the registry. `enLocale`, `ruLocale`, `arLocale`, `trLocale`, `zhLocale`, `deLocale`, `frLocale`, `daLocale`, `hiLocale`, `locales` and `localePacks` are provided presets/registries.

### ObjectManager full method index

Create with `objectManager(options?)`; `remoteObjectManager(options)` adds viewport loading and the same collection API.

| Method | Behavior |
| --- | --- |
| `add(objectOrArray)` | Insert/replace by id and update spatial/search/time indexes |
| `addAsync(iterable, options?)` | Cooperative bulk ingest; supports async iterables, progress, cancellation and one final invalidate |
| `beginBulk()` / `endBulk({ render? })` | Coalesce layout invalidation and rendering for chunked ingest |
| `update(objectOrArray, options?)` / `updateObjects(iterable, options?)` | Replace existing object data; fast paths patch properties or GPU positions |
| `moveObject(id, coordinates, options?)` | Move one object; optional animation/duration |
| `removeObjects(ids)` / `remove(ids)` | Remove data by id (`remove()` with no ids detaches from map) |
| `clear()` / `destroy()` | Clear data / fully release manager resources and handlers |
| `getObject(id)` / `getObjects()` | Read one object / a snapshot array of stored objects |
| `setFilter(fnOrNull)` | Apply an application predicate without mutating objects |
| `setVisibleIds(idsOrNull)` | Explicit GPU-visible subset; `null` restores normal selection |
| `setSceneFeatures(enabled)` | Toggle icons/labels/trails/paths; `false` is the mass-point fast path |
| `setSelected`, `getSelectedId`, `setHovered`, `getHoveredId` | Exclusive selection/hover conveniences |
| `getObjectState`, `setObjectState`, `setObjectStates` | Read/patch transient scalar state |
| `removeObjectState`, `clearObjectStates` | Delete selected state keys / all transient state |
| `setStyle(resolverOrNull)` | Set data/state/zoom-aware style or restore legacy styling |
| `registerIcon`, `removeIcon`, `hasIcon`, `clearIcons` | Manage the symbol atlas |
| `search(query, options?)` | Query the configured local search index |
| `setTime(timestampOrNull)`, `setTimeRange(from, to)` | Apply temporal visibility filtering |
| `setVisualization(mode)` | Select objects/clusters/heatmap/auto |
| `focusObject(id, options?)` | Center/zoom the attached map on an object |
| `bindPopup`, `unbindPopup`, `openPopup`, `closePopup`, `hasOpenPopup` | Object popup lifecycle |
| `bindClusterPopup`, `unbindClusterPopup` | Cluster popup lifecycle |
| `setClusterize`, `setClusterGridSize`, `setClusterRenderer` | Change cluster behavior/rendering |
| `prepareLayout(zoom?)` | Await initial/off-thread hierarchy preparation |
| `spiderfyCluster(id)`, `unspiderfy()` | Expand/collapse overlapping maximum-zoom members |
| `getStats()` | Return object/index/visible/renderer/layout counters |

`RemoteObjectManager.reload()` re-requests the current viewport; `cancel()` aborts the active load. Its loader receives bounds, zoom and an `AbortSignal`; stale completions are ignored.

### GPU, heat and geometry processing

| Export | Purpose |
| --- | --- |
| `webglPointLayer` | Packed high-volume points; `setData`, cooperative `setDataAsync`, `setPackedData`, per-point colors/sizes and optional picking |
| `webglSymbolLayer` | Atlas-backed rotated symbols |
| `webglPathBatch`, `webglStyledPathBatch`, `webglPolygonBatch` | Batched GPU paths/polygons |
| `heatLayer`, `webglHeatLayer` | Canvas/GPU density or value heatmaps; WebGL supports cooperative `setDataAsync` |
| `heatIsolineLayer`, `buildHeatIsolines` | Render/build marching-squares isolines |
| `heatRadiusScale`, `heatIntensityScale`, `heatKernelAtZoom` | Shared heat scaling calculations |
| `geometryWorkerPool`, `preparePointBatch` | Worker/fallback packed point preparation |
| `buildClusterLayout`, `buildClusterIndex`, `queryClusterLayout` | Public clustering primitives for custom renderers |

WebGL layer `getStats()` methods report renderer-specific counts/capabilities. Synchronous `setData()` remains the lowest-wall-time path for bounded inputs. Point/heat `setDataAsync(input, options)` defaults to 50,000 items per chunk and accepts `yieldMode`, `signal` and `onProgress`; the previous live dataset remains unchanged if preparation is cancelled. `setPackedData(..., { adopt:true })` transfers ownership of compatible typed arrays and must only be used when the caller will not mutate them. `webglPathBatch` scales its exact-redraw interval for batches above 15,000 segments so a slow submit cannot trigger another full submit on the immediately following animation frame.

`GeometryWorkerPool.preparePoints(input, options)` also accepts sync/async iterables and cooperatively serializes them before worker transfer. When workers are unavailable, `preparePointBatchAsync()` provides the same chunking, progress and cancellation contract on the main thread; use synchronous `preparePointBatch()` only for bounded inputs.

### Providers and operational services

| Factory/class | Main methods and contract |
| --- | --- |
| `createArraySearchProvider(items, options?)` | In-memory search adapter |
| `createSearchProvider(adapter, options?)` / `SearchProvider` | `search`, `geocode`, `reverse` |
| `createSuggestProvider(fetcher, options?)` / `SuggestProvider` | Debounced `suggest`, `cancel`, `destroy` |
| `createSuggestWidget(options)` / `SuggestWidget` | `attach`, `select`, `cancel`, `destroy` |
| `routingLayer(options)` | `route`, `select`, `getRoutes`, `cancel` |
| `createStraightLineRoutingProvider()` | Dependency-free fallback route provider |
| `trafficLayer(options?)` | Provider-owned traffic state/refresh layer |
| `offlineTileCache(options?)` | `prefetch`, `prefetchTileLayer`, `match`, `clear`, Service Worker generation/registration |
| `performanceInspector(map, options?)` | `snapshot`, `measureFrames`, `start`, `stop` |
| `createMapAdapter(container, options?)` | Framework-neutral create/update/destroy adapter |
| `defineOrihonElement(name?, options?)` | Registers the optional custom element |

`OfflineTileCacheOptions` includes `cacheName`, `fetcher`, `maxTiles`, `concurrency` (default 8, maximum 32) and `urlPrefixes`. See `SECURITY.md` before caching remote URLs.

### Vector tiles and optional package entries

`vectorTileLayer(options)` renders provider results. `createMVTProvider(urlTemplate, decodeOptions?)` fetches and decodes Mapbox MVT or supported MLT. `decodePackedMVT` preserves tile-local packed geometry; `packedToGeoJSON` converts it; `decodeMVT` is the direct compatibility function with byte/feature/string limits.

Optional entry functions:

| Entry | Public functions/classes |
| --- | --- |
| `orihon/pmtiles` | `PMTilesArchive`, `createPMTilesProvider`, `createPMTilesRasterSource`, `deserializePMTilesDirectory`, `findPMTilesEntry`, `zxyToTileId` |
| `orihon/mlt` | `encodePackedMLT`, `decodePackedMLT`, `decodeMLT`, `looksLikeMLT`, `createMLTProvider` |
| `orihon/mvt-wasm` | `mvtGeometryWasmSupported`, `mvtGeometryWasmError`, `decodeMvtGeometryWasm`, `decodePackedMVTWasm`, `createMVTWasmProvider` |
| `orihon/webgpu` | `WebGPUTileLayer`, `webgpuTileLayer` |
| `orihon/controls` | `fullscreenControl`, `measureControl`, `miniMap`, `graticuleLayer` and their classes/options |
| `orihon/geo` | Geography helpers plus `bufferPoint` |
| `orihon/popup-content` | `popupContent`, `sanitizePopupHtml`, `popupConditionMatches`, `createEChartsPopupRenderer` |
| `orihon/draw` | `DrawHandler`, `drawControl`, `snapLatLng`, `drawHandle`, locale helpers |
| `orihon/react` | Components/hooks listed above |

For exact option shapes and generic result types, use the declarations shipped beside each ESM file. Only paths in `package.json#exports` are public and versioned; direct `dist/services/*` or `dist/layers/*` imports are unsupported.
