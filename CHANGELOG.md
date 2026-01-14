# Changelog

## Unreleased

- Geometry worker lifecycle: caller-owned pools are isolated from ObjectManager's internal shared worker, `destroy()` is terminal and rejects pending work with `AbortError`, and worker crashes, message deserialization failures, malformed responses and `postMessage` exceptions now reject affected operations with a contextual `GeometryWorkerError` instead of leaving promises pending. A failed worker is discarded and recreated on the next operation.
- Common data model: added the optional zero-dependency `orihon/source` entry with `featureSource()` / `createFeatureSource()` / `FeatureSource`. The read-only structural protocol (`ReadonlyFeatureSource`, versioned snapshots and delta changes) lives in Core types, so renderers do not depend on the implementation entry. Canonical GeoJSON `feature.id` drives `add`, `addMany`, `update`, `remove`, `replace`, `clear` and `batch`. The same source can drive `geoJSON(source)`, `textLayer(source, options)`, Easy `addGeoJSON(source)` and Advanced `objectManager({ source })`; renderer state stays consumer-local, layer subscriptions follow add/remove lifecycle, and ObjectManager stays data-bound until `destroy()`.
- Easy basemaps: `createMap({ basemap })` and `map.setBasemap()` now accept any ready `Layer`, including WMS, WMTS and custom implementations, in addition to raster URL/templates and options. `getBasemap()` returns the original layer, and replacing it removes only the previously managed basemap.
- Size audit: consolidated the shared image/video/SVG overlay lifecycle, embedded-WASM Base64/memory/alignment helpers, DOM/GPU tile-bounds validation, WebGL opacity/distance helpers and the MVT PBF reader used by the feature-level WASM fallback. Removed the redundant `TileLayer.setOpacity()` override while preserving the inherited contract. The npm allowlist now ships documentation pages without internal Confluence/playground source datasets.
- Unified style vocabulary: ObjectManager points now use canonical `fill` / `fillOpacity` / `size`; `color` / `opacity` remain aliases. Managed lines likewise accept `stroke` / `strokeOpacity` / `strokeWidth` while preserving `color` / `opacity` / `width`. Canonical names win consistently in DOM, SVG, WebGL, icon tinting and style-state patches.
- Easy API: added the optional `orihon/easy` subpath. Its Standard-powered `createMap()` accepts a declarative `basemap` and a typed `map.add(description)` union for marker, polyline, polygon, GeoJSON and raster layers, while the returned regular Orihon instance also exposes discoverable `addMarker()`, `addTileLayer()`, `addPolyline()`, `addPolygon()`, `addGeoJSON()`, `setBasemap()` and `getBasemap()`. Every map has the short `add(layer)` alias alongside `layer.addTo(map)`. Documentation treats Core/Standard/Advanced package complexity separately from Easy/Layer/Rendering API complexity; `addSource()` remains reserved for a real reusable-source lifecycle.
- Coordinate-order API: added `lngLat(longitude, latitude)` as an explicit MapLibre/GeoJSON migration boundary. It returns the regular Orihon `LatLng`, complements `latLng(latitude, longitude)`, and is exported from the main, Core, Standard, Geo and global browser entries.
- Public API consolidation: `tileLayer()` now owns DOM/WebGL/WebGPU selection plus GPU-only `maxDpr` and `maxNewPerFrame`; `objectManager()` now accepts normal options, `{ loader }`, or `{ points }` with preserved DOM/SVG/WebGL/hybrid behavior; `pathBatch()` replaces the two renderer-named path factories; `searchProvider()` accepts an array or adapter; and `icon()` accepts `{ iconUrl }` or `{ content }`. The redundant public factories were removed while their specialized implementation classes remain available where useful.
- GPU tile fallback: a browser may expose `navigator.gpu` yet fail to provide an adapter/device. Unified `tileLayer({ renderer:"webgpu" | "auto" })` now falls through to the same WebGL tile pipeline instead of leaving an empty canvas. A Chromium acceptance test verifies active WebGL rendering, GPU option forwarding and WebGPU-to-WebGL fallback.
- API pruning: removed public `extendBounds()` (use `bounds(points)` or `bounds(existing, value)`), the empty `gridLayer()` factory (subclass `GridLayer`), and the demonstration-only `canvasBaseLayer` module and demos. The Developer Guide now contains 72 current public functions.
- Geo API simplification: the general geographic factory is now `bounds()`; it accepts a coordinate, a coordinate array, two opposite corners, or an existing bounds object. The redundant public `latLngBounds()` name was removed. Pixel/cartesian rectangles remain explicit through `pointBounds()`.
- MVT API boundary: `decodePackedMVT`, `decodePackedMVTAsync`, `packedToGeoJSON` and their packed result types now live in the explicit `orihon/mvt` advanced entry. The main `orihon` API and Developer Guide keep the normal `createMVTProvider` / `decodeMVT` path.
- Developer Guide clarity: all public function pages now use purpose-oriented Russian summaries, type-aware parameter explanations and concrete return descriptions instead of generated placeholders. Interactive results moved out of the map iframe, leaving the map unobstructed.
- Developer Guide navigation: pure calculations and data transformations now live in a dedicated “Вычисления без отрисовки” category, separate from functions that create visible map layers or controls.
- Public API boundary: renderer wiring (`registerGpuTileFactory`) and the five camera/CSS transform helpers are now internal implementation details and are no longer exported from `orihon` or included in the Developer Guide.
- Heat API consolidation: the former Canvas heat, point-splat WebGL heat and standalone isoline layers were removed. One `HeatLayer` now owns one scalar field and exposes the short `heatLayer()`, `buildHeat()`, `heatSupport()`, `mode`, `backend`, `evaluation`, `labels`, `step`, `bands`, and `cover` API. Source modules are now `layers/heat` and `services/heat`; low-level WASM/WebGPU field and contour code remains internal backend infrastructure.
- Interactive isolines and heat zones: `HeatLayer` now performs stroke-first contour hit testing plus bilinear scalar-grid zone identification. It supports hover/mouse events, click and context-menu events, standard popup/tooltip factories, persistent selection, programmatic query/selection, and separate hover/selection boundary highlights. Interaction metadata exposes exact field/range values and contour geometry without recomputing the field.
- Adaptive isoline levels: automatic unified-pipeline levels now optimize spatial coverage instead of using a uniform engineering step. The lazy selector combines robust 2–98% quantiles, an expanded quantile/uniform candidate pool, zone-based marginal coverage, range representation, overlap/redundancy penalties, and fragment filtering. Added NoData masks, minimum length/area filters, per-ring length/area/gain metadata, result coverage/redundancy diagnostics, and an acceptance regression asserting `C_adaptive > C_uniform` on a heterogeneous field.
- Heat field v2: replaced point×kernel-area splats with weighted cell aggregation plus separable Gaussian KDE in both WASM and WebGPU (`O(N + grid × radius)`). Added full-dataset `evaluation:"static"` and zoom-refined `"zoom"`, automatic or absolute `step`, filled isoline bands and lowest-zone domain coverage. First field compute now runs in the persistent Worker; a local 1M / 512² / `both` WASM verification completed in 78.1 ms (65.0 ms field + 12.8 ms contours; machine-dependent).
- Heat domain rendering: `cover:true` paints the zero-value zone across the complete visible surface, so the finite field bitmap cannot expose a rectangular edge. The field footprint includes the complete configured blur halo, logarithmic display compression keeps broad weak density visible beside isolated high-density hubs, and a contrasting contour casing prevents low isolines from merging into their filled bands. `auto` keeps contour modes on WASM to avoid GPU readback and preserve deterministic million-point geometry.
- Heat pipeline: added `heatLayer` / `buildHeat` and ObjectManager `heatmapDisplay`, `heatmapIsolineLabels`, and `heatmapBackend` flags. A single world-space scalar grid now drives continuous colors, WASM marching/stitching contours, and labels. The field has a compact WASM kernel plus a parallel WebGPU backend with measured readback and deterministic fallback; `auto` avoids GPU readback for contour modes. Added the 10k–1M / 256²–1024² browser A/B matrix.
- Heat pipeline ingestion/benchmarks: added cooperative `HeatLayer.setDataAsync()` with progress and cancellation. `bench-compare` now exercises the unified heatmap, isolines and combined modes instead of the legacy point-disc/standalone layers.
- Heat interaction: the first field paints without cold-worker startup latency, then a persistent module Worker handles later zoom/settle field and contour rebuilds. The completed overscanned heat surface is compositor-warped during camera motion instead of repainting a DPR canvas every frame. The comparison benchmark reports Field/Contours/Paint separately; the 50k combined browser case improved from ≈31 FPS / 37% drops to vsync-capped / 0% drops in the verification run.
- Browser bundle fix: reserve embedded WASM export names during Terser property mangling. Previously `orihon.esm.js` renamed `__heap_base` and silently fell back to JavaScript even though direct ESM WASM tests passed; the bundled artifact now has a dedicated browser regression test.
- Size policy: the Advanced bundle now includes whole-index clustering/MVT WASM and the v2 unified heat pipeline at 140.99 KiB gzip; WebGPU heat compute stays in a lazy chunk and the enforced Advanced ceiling is 141 KiB.

## 1.0.6

- Brand assets: production SVG/PNG logos, favicons, avatar and design tokens are published through `orihon/brand/*`; README and primary examples now use the packaged artwork.
- Raster tiles: WebGL/WebGPU zoom-out and pan repaint whenever a CSS-warped framebuffer would fail to cover the viewport. The renderer now preloads the next coarser viewport, composites ready parent/backstop/exact textures coarse-to-fine, reprioritizes queued work when it becomes visible, and temporarily pins the zoom round-trip route. Directional prefetch follows the actually revealed edge. The comparison benchmark adds a tile-scroll/zoom-out scenario with minimum geometric coverage, settle, request and reload metrics.

- Security: popup HTML sanitization now rejects active controls, inline CSS, SVG/MathML and obfuscated unsafe URL schemes; `_blank` links receive `noopener noreferrer`.
- Security/performance: offline prefetch validates URL origins, accepts only HTTP(S), awaits Service Worker cache writes and limits network concurrency (default 8).
- Performance: existing temporal-index records update/remove in O(1) instead of scanning the full record array.
- Performance: clustered collections above 250k points no longer build an unused all-zoom hierarchy during camera stress; requested zoom layouts are coalesced and built in a worker, and `getStats().clusterStrategy` exposes the active path.
- Performance/memory: WebGL GeoJSON lines no longer retain a second pair of typed coordinate arrays for canvas fallback. `retainFeatures:false` supports write-once packed path ingestion, and the browser benchmark now reports active heap delta plus retained baseline growth across repeated runs. Continuous path pan/zoom now camera-warps between throttled exact GPU frames (with an adaptive cadence for large batches), then redraws exactly on settle; clearing an empty batch also clears the previous framebuffer.
- Performance/API: `GeoJSONLayer.addDataAsync()` parses raw JSON strings/Blobs in a Worker and applies backpressured chunks; parsed GeoJSON and `AsyncIterable` sources yield cooperatively without cloning the full object graph. Imports support progress, cancellation, raw byte limits and a CSP-compatible fallback. The browser line benchmark now uses this asynchronous ingestion path.
- Performance: cooperative GeoJSON task ingestion prefers `scheduler.yield()`, falls back to `MessageChannel`, and does not yield after the final chunk, avoiding the browser's nested `setTimeout(0)` clamp on million-line imports.
- Performance/API: `ObjectManager.addAsync()`, `WebGLPointLayer.setDataAsync()` and `WebGLHeatLayer.setDataAsync()` cooperatively ingest large iterable/async-iterable inputs with progress and cancellation. Point/heat layers prepare private packed buffers and swap the live GPU dataset only after a successful import.
- Performance: `GeometryWorkerPool.preparePoints()` no longer performs a blocking `Array.from()` before posting to its worker; both worker serialization and the no-worker fallback now consume sync/async iterables cooperatively with progress and cancellation.
- Performance/API: `MarkerCollection` DOM mode now renders its configured point size/color, keeps internal markers out of the map-wide frame loop, and recycles viewport markers instead of repeatedly destroying/recreating them. New `renderer:"svg"` keeps every point in DOM as lightweight SVG circles under one shared style/camera transform and can promote a bounded visible subset to full HTML Marker buttons through `htmlButtonLimit`; `renderer:"hybrid"` remains available for HTML over a WebGL remainder.
- Fix/Performance: SVG and HTML-button markers now live under one camera-warped HTML root, preventing coordinate drift. The nested SVG is clipped to its viewport instead of using unbounded `overflow:visible`, allowing Chrome to cache a finite raster surface (restoring ≈60 FPS / 0% drop at 5k DOM points).
- Performance/API: SVG `MarkerCollection` now chooses automatic HTML buttons by viewport screen cells instead of insertion order. `buttonCellSize` defaults from point size and controls density, while `setSelected()` / `setPointSelected()` keep user-selected visible objects as buttons even above the soft `htmlButtonLimit` budget.
- Size policy: responsive mass-ingestion and adaptive DOM/SVG marker selection bring Standard to 35.87 KiB and Advanced to 106.44 KiB gzip; enforced ceilings are 36 KiB and 107 KiB.
- Tooling: Node ≥22 is required, Node 24.19.0 LTS is pinned, and dependency/benchmark version policy is documented.
- Tooling: GitHub Actions use current Node 24 runtimes; CI keeps a Node 22 compatibility job and runs the full release/browser matrix on Node 24.
- Benchmarks: the Node ObjectManager benchmark uses the public package entry only; the browser comparison uses current pinned Orihon/OpenLayers/MapLibre versions and rebuilds local `dist` before serving. Leaflet/OpenLayers per-feature GeoJSON-line rows are capped at 50k; larger MapLibre rows use a valid compact `MultiLineString` Blob URL instead of cloning one million main-thread `Feature` objects. MapLibre load timing now waits for the GeoJSON source to finish.

## 1.0.5

### License & positioning
- Relicensed the map engine to **Apache License 2.0**. Commercial use no longer needs a separate paid engine license.
- Positioning: Orihon is a free, open-source browser map engine. Apache 2.0. Use it anywhere. Orihon Studio is the visual editor.

### Camera & continuous zoom
- Shared camera helpers (`camera.ts`): `geoTransformCss`, `cameraWarpCss`, `tileLevelWarpCss`, `tileCornerLayerTransform`, plus `map.getCamera()`.
- Geographic `translate3d` no longer integer-rounds, so tiles, markers, SVG and overlays stay glued during fractional wheel zoom.
- TileLayer `#switchZoom` never CSS-warps with a NaN level origin (forces a heavy pass). WebGL/WebGPU tile warps use the same camera math.
- Regression: `test/camera-sync.test.js`, `test/fixtures/camera-sync.html`, Playwright continuous-wheel glue check (≤ 0.75 px).

### Markers & UI
- Marker built-in glyphs: `shape` (`pin` | `circle` | `square` | `dot` | …), `color`, `strokeColor`, `size`, `strokeWidth`, and `setAppearance()`.
- Locale packs split for smaller Core/Standard bundles (`locale-en`, `locale-packs`, lazy packs).

### ObjectManager & heatmaps
- ObjectManager scene pipeline: mixed geometry, trails, search/time indexes, icon atlas, label layout, cluster aggregations, styled path/polygon/symbol WebGL batches.
- 1M clustering Load path: mass-point ingest skips scene Maps, greedy packed cells, worker avoids structured-cloning a million ids. Hierarchy builds after first paint. `setFilter` on clustered sets queries the existing tree (no per-toggle recluster).
- Heatmaps encode geographic density (mass / kernel area) by default. `webglHeatLayer({ field: "value" })` uses a mean→peak blend from local alarm-mass share. ObjectManager heat keeps explicit zero weights; value kernels stay local; zoom rebuilds before CSS aureoles.

### Tiles, MVT, MLT, WebGPU
- Faster live tiles: incremental coverage (`tile-grid`), velocity-biased fetch, WebGL2 texture-array draws, W-TinyLFU GPU cache admission.
- Raster fill continues after the first `maxNewPerFrame` batch until the viewport is complete.
- Advanced `createMVTProvider` / `decodePackedMVT` sniff Orihon MLT and decode MVT geometry with WASM; `tileLayer({ renderer: "auto" })` prefers WebGPU when `navigator.gpu` exists.
- Optional entries: `orihon/mlt`, `orihon/mvt-wasm`, `orihon/webgpu`. Advanced gzip budget is **102 KiB**.

### Demos
- `examples/object-manager-live`, `examples/object-manager-scene`, `examples/aircraft-radar-proxy` (`npm run demo:aircraft`), `examples/rzd-train-122-tracker` (`npm run demo:rzd`, port 8788).

## 1.0.4

- Fixed CDN Advanced bundle crash on `createMap`: Terser property mangling renamed `_unsub` while esbuild class-field helpers kept the quoted `"_unsub"` key.
- Public HTML demos default CSS/JS pins to jsDelivr so `file://` opens without a `/dist` server.

## 1.0.3

- Added lazily loaded `map.exportPng()` / `map.print()` with safe canvas/SVG/image compositing, no arbitrary HTML rasterization, and a real browser pixel-composition regression.
- Added optional `orihon/geo` with geodesic `bufferPoint` and focused geography re-exports.
- Added unified `map.query()` / `queryLatLng()` hit testing across DOM, SVG, canvas, WebGL, clusters and managed objects.
- Added Standard `textLayer` with point/line placement, priority collision, halo/offset styling and RTL locale alignment.
- Added declarative MVT paint rules, Standard WMTS REST templates/capabilities parsing, and optional zero-dependency `orihon/pmtiles` v3 range reading backed by a committed binary fixture.
- ObjectManager clusters now fit member bounds below maximum zoom and spiderfy into circle/spiral layouts at maximum zoom independently of `clusterZoomOnClick`.
- Added browser acceptance coverage for mixed renderer queries, repeated 12-point spiderfy, RTL label collision/alignment and WMTS tile loading.
- Draw: circle center/radius edit handles, toolbar redo + draw-owned locales (`drawRedo` / `resolveDrawLocale`), window-level Esc/Enter/Ctrl+Z/Y. Draw UI strings live in `orihon/draw`, not core `OrihonLocale`.
- Added Leaflet-compatible `CRS.Simple`, map-scoped projection/distance, and typed WebGL CRS guards.
- Added SVG/canvas path dashes and arrows, great-circle interpolation, geodesic circles, and marker rotation.
- Added optional `orihon/draw` + `orihon/draw.css` with draw/edit/delete, snapping, history, GeoJSON import/export and nine localized toolbars.
- Added optional `orihon/react` bindings with declarative layers, popup/tooltip children, map hooks, ObjectManager id diffing and Strict Mode lifecycle coverage.
- DivIcon string content is always `textContent` (no HTML heuristic). Pass a `Node` for markup.
- SVG string sanitizer strips `style`/`use`/`image`/`a` and non-fragment URLs.
- `offlineTileCache({ urlPrefixes })` also filters `prefetch()`; blocked schemes are rejected.
- Map camera frames skip layers with `wantsFrameRender() === false` (heat, marker collection).
- Cluster canvas and heat isolines paint once per frame; canvas resize is size-checked.
- `SpatialGridIndex.searchIds`, packed ObjectManager layout coords, WebGL point spatial pick, ImageBitmap tile upload after decode.
- Ingest caps: `decodeMVT` defaults, `geoJSON({ maxFeatures })`, `objectManager({ maxObjects })`.
- Deduplicated clustering worker source, shared WebGL/geo helpers, and packed locale tables (no API change).
- Advanced gzip budget is **75 KiB**; Core and Standard load map export only on first use, while optional P2 controls and geo helpers keep their own budgets.
- Canvas GeoJSON batches now emit feature-aware click events and support `bindPopup()` / `GeoJSONOptions.popup` for polygons and lines.
- Popup/tooltip activation now uses pointer-tap semantics across SVG, canvas, WebGL, markers and media overlays.
- Added optional `orihon/popup-content`: a reusable declarative renderer for safe HTML, text, image, video and adapter-driven charts.
- Published demos on GitHub Pages are CDN showcase + bench only (Map Studio stays local / unpublished).

## 1.0.2

- First public release of the `orihon` npm package.
- Map class: `Orihon`; globals: `Orihon` / `OrihonReady`.
- Events: `OrihonEvent`. Locales: `OrihonLocale`.
- CSS entry: `orihon/orihon.css` with `oh-*` class prefix.
- Web Component tag default: `orihon-map` via `defineOrihonElement()`.
- Bundle artifacts: `orihon.core.esm.js`, `orihon.standard.esm.js`, `orihon.esm.js`, `orihon.global.js`.
- Licensed under PolyForm Noncommercial License 1.0.0 (see `LICENSE` and `LICENSE-NOTICE.md`).
- Named ESM / Core / Standard / Advanced entries.
- Publishable tarball is library-only (`dist`, docs, license files) — no demo.
- UI locales: `en` (default), `ru`, `ar`, `tr`, `zh`, `de`, `fr`, `da`, `hi`.
- Canvas heatmaps via `heatLayer` / `HeatLayer` with weighted `[lat, lng, intensity?]` points.

### Fixed
- ObjectManager cluster centers now convert averaged layer points via `containerPointToLatLng` instead of `unproject`.
- `Orihon.destroy()` stops flyTo/inertia animation and ignores further `setView` / `#applyView` after teardown.
- Offline Service Worker only network-caches URLs under `urlPrefixes` and never caches opaque responses for arbitrary GETs.
- `prefetchTileLayer` requires `bounds` or explicit tile ranges and enforces `maxTiles`.
- GeoJSON path bounds no longer use `Math.min(...spread)` (stack-safe loop).
- Polygon/GeoJSON hole culling uses whole-geometry bounds; Douglas–Peucker simplification is iterative.
- SVGOverlay string content is sanitized before DOM insertion.
- Layer attribution is handled in the base `Layer` lifecycle; GeometryWorker blob URLs are revoked; RoutingLayer cancels on remove; geolocation ignores late callbacks after control removal.
