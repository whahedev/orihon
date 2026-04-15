# Changelog

## Unreleased

- **Breaking — `LatLng.toArray()` is removed.** It returned `[lat, lng]`: a value no geographic
  API in this library accepts back, since `LatLngLike` dropped bare tuples, and one that reads
  exactly like a longitude-first GeoJSON position. A method whose only possible output is a
  shape the library refuses is a footgun, not a convenience. Use `toGeoJSONPosition(latlng)` to
  export (`fromGeoJSONPosition` reads it back), or `{ lat: latlng.lat, lng: latlng.lng }` to keep
  the names attached — that serializes as-is. `Point.toArray()` is unaffected: `[x, y]` in
  screen space has no competing convention.

- **Fixed — constructing a map queued a microtask per instance.** `localeReady` derived a
  `.catch()` handler from an already-resolved promise even when the locale needed no loading.
  Attaching to a settled promise schedules a job, and that job's closure keeps its map reachable
  until the queue drains — so a synchronous loop of map create/destroy cycles held every map at
  once. The lifecycle leak test measured 4.85 MiB of growth against 0.04 MiB before. Maps whose
  locale is already in place now share one settled promise and attach nothing.

- **Fixed — two browser tests still read `event.detail`.** `tile-gpu-browser.mjs` and
  `heat-browser.mjs` were missed when event payloads were flattened. The handler threw after
  clearing its own timeout, so the promise settled neither way and Playwright reported
  "Resulting promise was garbage collected" instead of the real error — which blocked the
  `test:leaks`, `test:plugin` and `size` steps behind it in CI. The tile helper now rejects with
  the underlying failure rather than hanging.

- **Breaking — camera moves name their animation instead of toggling a boolean.**
  `fitBounds`, `fitWorld` and `panInsideBounds` took `animate?: boolean`, where `true` meant
  precisely "call `flyTo`" — a flag standing in for a choice of implementation. They take
  `animation?: "none" | "fly"` now (default `"none"`), which says what runs and leaves room for
  further curves without a second flag. `ObjectManager.focusObject` follows the same vocabulary
  and, unlike before, actually honours it: its `animate` option was accepted and never read.
  Passing `animate` throws `TypeError` — an unknown key in an options bag is ignored in silence
  by JavaScript, so the rename would otherwise stop animating without a word. The shared
  `CameraAnimation`, `CameraMotionOptions` and `FitBoundsOptions` types are exported.
  `ObjectManager.update()` keeps its `animate` boolean: it interpolates a move rather than
  selecting between named implementations.

- **Breaking — `setView(center, zoom, { settle: false })` becomes `updateView(center, zoom)`.**
  `settle` named an internal concept (ending the view session) rather than what the caller
  wants, and it read as a double negative in the one situation it exists for. The two motions
  are now two methods: `setView` moves the camera and finishes, `updateView` performs one step
  of a continuous motion — follow-cam, an animation frame, a live position feed — leaving the
  gesture open. `SetViewOptions` is gone; it existed only to carry that flag.

- **Added — `map.setMinZoom()` / `map.setMaxZoom()`.** The zoom range could previously be
  changed only by writing `map.options`, which stopped compiling when options became a read-only
  view — and never re-clamped the live zoom anyway. Both setters validate (`TypeError` for a
  non-finite value, `RangeError` when the range would invert) and re-clamp immediately, so
  raising `minZoom` above the current zoom zooms in instead of leaving the map outside its own
  limits until the next interaction.

- **Changed — `LatLng` is frozen at runtime, not only in the type surface.** It is a value
  object, so `Object.freeze` in the constructor makes `latlng.lat = 0` throw instead of silently
  aliasing a coordinate the map or a layer still holds. The freeze costs about 17ns per instance
  (measured; roughly 2.3x on construction alone), which lands on one-time ingests rather than
  per-frame work.

- **Fixed — `FeatureSource.batch()` coalesced by the last verb instead of by the net change.**
  A subscriber only sees the flush, so the delta it needs depends on where each id started and
  ended, not on which mutation ran last. `remove("a")` followed by `add(a2)` emitted an `add`,
  which left `GeoJSONLayer` with two layers for one id because `add` does not drop an existing
  one; it is an `update` now. Worse, `remove("a")`, `add(a2)`, `remove("a")` cancelled pairwise
  into an empty intent map, so the flush emitted nothing and did not bump `version` even though
  `"a"` was gone — subscribers kept rendering a feature the source no longer had. Batch state is
  tracked per id as (initially present, currently present), giving `add` / `update` / `remove` /
  no-op directly; a batch whose ids all end where they started still emits nothing, which is
  now a decision rather than an accident.

- **Internal — `TextLayer` imports its GeoJSON types from `geojson-types.ts`** rather than from
  the `geojson.js` layer module, matching `ObjectManager`. Type-only either way, but it keeps
  the layering readable.

- **Breaking — an explicit GPU renderer refuses instead of falling back.**
  `tileLayer(url, { renderer: "webgpu" })` returned DOM tiles when WebGPU was unavailable or no
  GPU implementation was registered, so the same code read as a GPU path in development and
  profiled as a DOM path in production, with nothing raised in between. `"auto"` is the
  preference form and still degrades WebGPU → WebGL → DOM; `"webgl"` and `"webgpu"` name one
  implementation, which makes them a requirement, and now throw `UnsupportedCapabilityError`
  (`code: "ERR_UNSUPPORTED_CAPABILITY"`) with `context.reason` of `"unregistered"` or
  `"unsupported"`. Omitted `renderer` is still DOM.

- **Breaking — the map's live state is read-only on the public surface.** `center`, `zoom`,
  `size`, `pixelOrigin` and `panVelocity` were writable fields, so the camera could be moved
  past `setView` / `setZoom` without clamping, view-session events or a render pass. They are
  private with read-only views now, joining `layers`, `controls` and `panes`. `map.options`
  becomes `get options(): Readonly<ResolvedMapOptions>`, matching `Layer.options`: assigning
  `options.controls = false` never removed the existing controls and `options.locale = "ru"`
  never re-rendered them, so the setters are the only way. `BehaviorManager.states` is a
  read-only view for the same reason — writing a flag skipped `behaviorchange`.

- **Breaking — `LatLng.lat` and `LatLng.lng` are readonly.** A coordinate handed out by
  `getCenter()`, `getCamera()` or a layer is a value, not a handle on that object's live state.
  Derive a changed coordinate with `new LatLng(...)`, `clone()` or `latLng()`.

- **Fixed — `getCamera()` is the immutable snapshot it documents.** `pixelOrigin` and `size`
  were copied but `center` was handed out by reference, so writing through the snapshot could
  reach the live camera. `center` is cloned, and `CameraState` is readonly throughout.

- **Breaking — `tileLayer()` defaults to `renderer: "dom"` in every tier.** The default was
  `"auto"`, and the Advanced `orihon` entry registers a GPU implementation as an import side
  effect, so moving an import from `orihon/standard` to `orihon` silently switched an existing
  `tileLayer(url)` call from DOM tiles to WebGPU/WebGL — a different renderer, memory profile and
  fallback path, with no change to the call itself. What a call builds now follows its arguments.
  GPU rasters stay one option away: `tileLayer(url, { renderer: "auto" })`.

- **Breaking — popup and tooltip binding moved to `InteractiveLayer`.** `Layer` is exported from
  `orihon/core`, but the overlay implementation ships in `orihon/standard`; `bindPopup()` on a
  Core layer type-checked and then threw at runtime. `Layer` is now the capability-honest Core
  base, and `InteractiveLayer` (exported from `orihon/standard` and `orihon`) carries
  `bindPopup` / `bindTooltip` and their companions. Every layer that could usefully anchor an
  overlay — markers, vectors, GeoJSON, groups, overlays, heat, WebGL layers — extends it, so
  existing code keeps working. Raster tile layers (`TileLayer`, WMS, WMTS, `GPUTileLayer`,
  `VectorTileLayer`) no longer advertise the methods; they had no geographic anchor of their own.

- **Breaking — public classes no longer expose renderer internals.** `Orihon` (`panes`,
  `controlCorners`, `controls`, `_attributions`, `_unsub`, `_viewSession`, `_wheelTimer`,
  `_animationFrame`, `_resizeObserver`, `_destroyed`, `_initialA11y`), `TileLayer`
  (`tiles`, `previousTiles`, `cache`, `level`, `_queue`, `_needed`, `_rect`, …) and
  `VectorTileLayer` keep their bookkeeping private. `panes`, `controlCorners` and `controls`
  remain readable as views; tile bookkeeping is reported by the new `getStats(): RasterTileStats`
  on the `RasterTileLayer` contract. `test/public-instance-surface.test.js` guards the instance
  surface the way `public-api.test.js` guards module exports.

- **Breaking — `SearchProvider.reverse()` reports a missing capability as `null`.** With no
  `reverse()` on the adapter it used to synthesise a result whose `name` was the formatted
  coordinates, so an unsupported operation looked like a successful lookup. Pass
  `{ fallbackReverse: "coordinates" }` to restore the placeholder.

- **Added — `map.isDestroyed` and a programmatic error contract.** `destroy()` was already
  terminal for `addLayer` / `addControl` / `createPane`, but there was no way to ask. Those
  guards now throw `DestroyedError` (`code: "ERR_DESTROYED"`), `bindPopup` without the overlay
  module throws `UnsupportedCapabilityError` (`code: "ERR_UNSUPPORTED_CAPABILITY"`), and both
  extend a new `OrihonError` base carrying `code` and `context`. `CRSCompatibilityError` and
  `GeometryWorkerError` extend it too, so library failures are discriminable without message
  matching. Argument validation keeps using `TypeError` / `RangeError`.

- **Added — `remoteObjectManager()` and `markerCollection()`.** `objectManager(options)`
  returns one of three different classes depending on which key is present, which is hard to
  predict and impossible to see at the call site when options are assembled dynamically. The two
  named factories make the choice explicit; `objectManager()` stays for the plain local manager
  and keeps accepting the other shapes.

- **Added — `map.localeReady`.** Standard and Advanced register locale packs at import;
  Core fetches them lazily, so `createMap(el, { locale: "ru" })` returned English strings
  tagged `language: "ru"` with no way to know when the real ones arrived. `localeReady`
  resolves once the requested locale is applied, in both tiers.

- **Fixed — a failed locale chunk is no longer swallowed.** `ensureLocalePacks()` caught the
  dynamic-import rejection and resolved as if the packs had loaded. It now rejects (and drops
  its cached promise so a later call retries); the map itself still falls back to English.

- **Added — `OfflineTileCache` `onError`.** `stats.failed` counted lost tiles without saying
  which URLs, or whether the cause was the allowlist, the network or Cache Storage quota — for
  offline work the failures are the interesting half. `onError(failure)` reports
  `{ url, stage, cause }` with `stage` one of `"url" | "fetch" | "cache"`.

- **Fixed — `map.query()` no longer depends on a private field.** It reads the public
  `map.layers` view, so hit testing is expressible in terms of the documented surface
  (attached layers plus pane order) rather than internal state.

- **Fixed — `Map.remove()` came back.** The documented ecosystem-compatible alias of
  `Map.destroy()` was dropped without a changelog entry while `docs/API.md`,
  `docs/API-DESIGN.md` and the React lifecycle test still relied on it. Leaflet-shaped
  `map.remove()` works again and is covered by a test.

- **Size claims are now verified, not written by hand.** `npm run size` checks the
  README budget table and the badge against `dist/release-manifest.json` and the
  budgets in `scripts/check-size.mjs`, and fails if any artifact crosses the
  advertised **150 KiB gzip** ceiling. `orihon/react` and `orihon.global.js` got
  budgets of their own (they had none). Previous READMEs advertised 75 KiB for a
  bundle that measured 123 KiB.

- **Dead code removed.** `earcutRing` (plus its ear-clipping helpers), `canvasPathBatch`,
  `tileRectContains`, `pointInNormalizedPolygon`, `bboxIntersects`, `ObjectSlotMap`,
  `clearLabelMetricsCache` and the `GeometryKind` alias had no callers anywhere in
  the library, tests or docs. Five identical WebGL program-link blocks now share the
  existing `linkProgram()` helper, which also releases the shaders it links.

- **Fixed — `tileLayer()` leaked a WebGL context per call.** The capability probe
  created a fresh canvas and context on every `tileLayer()` and never released it.
  Browsers cap live contexts, so a few basemap switches could force real map layers
  to lose theirs. The probe now runs once per document and calls `WEBGL_lose_context`.

- **Fixed — a no-op `setView()` cancelled a running animation.** `setView` stopped the
  camera before checking whether the view actually changed, so `flyTo` and inertia died
  on any React re-render that re-asserted the current `center` / `zoom`.

- **Fixed — camera animation could rewind for one frame.** `requestAnimationFrame`
  reports the frame's start time, which can predate the `performance.now()` captured
  when the animation began; the resulting negative progress moved the camera backwards.
  Progress is clamped in both `flyTo` and inertia, and `test/camera-animation.test.js`
  now covers non-zero-duration flights, which no test asserted before.

- **Fixed — `Evented` robustness.** A throwing listener no longer aborts the remaining
  handlers (`emit` runs inside the render loop); failures are reported through
  `reportError` instead. Cyclic `addEventParent` graphs propagate once instead of
  overflowing the stack. `off(type, handler)` now cancels a pending `once` subscription
  registered with the same function. `emit` also skips building the event object when
  nothing is listening.

- **Fixed — options explicitly set to `undefined` no longer break constructors.**
  `createMap({ zoom: undefined })` produced a `NaN` zoom and threw on coordinates;
  `objectManager({ clusterRadiusPixels: undefined })` threw a `RangeError`. Defaults
  now merge through `mergeOptions()`, which treats `undefined` as "not supplied" —
  the shape React props and conditional spreads produce constantly. `Circle`
  discriminates its radius unit by value rather than key presence, so
  `{ radiusMeters: undefined }` reports the real problem.

- **Fixed — the shared geometry worker outlived every map.** `ObjectManager` now takes
  and releases a reference (`acquireSharedGeometryWorkerPool` /
  `releaseSharedGeometryWorkerPool`); the worker thread and the coordinate dataset
  transferred into it are torn down when the last manager is destroyed.

- **Lifecycle after `Orihon.destroy()` is explicit.** Attaching to a destroyed map
  (`addLayer`, `addControl`, `createPane`) throws `Orihon map was destroyed` instead of
  a confusing internal pane error. Camera and query methods stay inert as before.

- **Breaking — flat events:** `emit()` no longer mirrors the payload under
  `event.detail`. Use `event.latlng` / `event.zoom` / … only.

- **Breaking — Easy object-first:** Easy `addMarker` / `addPolyline` / `addPolygon` /
  `addTileLayer` / `addGeoJSON` each take one options object. Positional forms are
  removed. Markers use nested `appearance`; polylines use `{ points, style }`;
  polygons use `{ rings, style }`; tiles use `{ url }`; GeoJSON uses `{ data }`.

- **Breaking — Layer `options`:** public `layer.options` is a `Readonly` snapshot.
  Assigning fields (e.g. `marker.options.opacity = 0.5`) no longer type-checks and
  never updated rendering. Use setters (`setOpacity`, `setStyle`, `setIcon`, …).

- **Breaking — layer iteration:** `eachLayer(callback)` no longer takes a
  `thisArg`/`context`. Prefer `for (const layer of map.layers)`. `map.layers` is
  now a `ReadonlySet` (no `add`/`delete`/`clear`); use `addLayer` / `removeLayer`.

- **FeatureSource performance:** `GeoJSONLayer` applies source `add` / `update` /
  `remove` / `batch` incrementally (SVG); `batch()` emits coalesced `batch`
  deltas instead of `reset`; `getSnapshot()` is cached per version; async
  `batch()` callbacks throw; `update()` is documented as always shallow-merge.
  GeoJSON domain types live in `geojson-types.ts`. `orihon/source` has a 5 KiB
  gzip CI budget. Standard gzip ceiling is 37 KiB.

- **Breaking — Easy dialects:** removed Easy `map.add({ type, ... })` and the
  description types (`EasyAddDescription`, …). Easy is map-centric only
  (`addMarker`, `addPolyline`, `addPolygon`, `addGeoJSON`, `addTileLayer`).
  Standard stays layer-centric (`marker(…).addTo(map)`). Inherited `addLayer`
  remains for deliberate mixing; there is no `map.add(layer)` alias.

- Circle radius accessors now mirror CircleMarker naming: `getRadiusMeters()` /
  `setRadiusMeters()` and `getRadiusMapUnits()` / `setRadiusMapUnits()`. The
  `CircleRadius` object API (`getRadius` / `setRadius`) remains for dual-unit
  switching; reading the inactive unit throws.

- DX quick wins: `MapAdapter.update()` is typed to center/zoom/behaviors; WMS
  `setParams` and raster `setUrl` accept `{ redraw }`; `IdentifiedGeoJSONFeature`
  tightens FeatureSource; `tileLayer()` returns `RasterTileLayer` with
  `rendererKind`; `prepareLayout()` awaits hierarchy settle; developer-guide
  examples for `createMapAdapter` / `createGeometryWorkerPool` match the live API.

- Event contracts now cover SVG paths, raster/vector tiles, traffic, text, heat, WebGL points/symbols and overlays, including popup/tooltip notifications on maps. Declarations preserve renderer differences: optional DOM tiles, nested vector coordinates, plain coordinate objects, nullable hover and absent packed-point data. Added compile-time rejection tests and DOM/GPU/heat payload regressions without changing runtime dispatch. See [layer event migration](docs/MIGRATION-NEXT-MAJOR.md#layer-and-overlay-event-payloads).

- **Breaking — event subscriptions:** `on` / `once` / `off` infer payloads and concrete receiver targets from literal names, with exported event maps for map, Marker, layer attachment, Draw and main services. React map callbacks share the contract; SuggestWidget retains its item type. Dynamic/custom names remain `unknown`. Old explicit payload type arguments must migrate to event maps. Runtime dispatch and permissive low-level `emit` remain unchanged. See [migration](docs/MIGRATION-NEXT-MAJOR.md#typed-event-subscriptions).

- **Breaking — exclusive visual/data modes:** Marker, icon and objectManager reject conflicting selectors in TypeScript and JavaScript, including pre-existing option variables. Marker `html` is replaced by safe `content`; empty content remains empty. `setContent()`, `setIcon()` and `setAppearance()` explicitly switch modes without reviving hidden content. Easy/React retain the union contract, point collections no longer mix glyph defaults into custom icons, and invalid manager selectors fail before subscriptions/iteration. See [migration](docs/MIGRATION-NEXT-MAJOR.md#exclusive-marker-and-factory-modes).

- Build contracts: Standard receives an additional compression pass without property mangling to retain its 36 KiB gzip budget. Minified artifacts preserve actual boolean return values instead of rewriting them to 0/1, keeping strict lifecycle checks compatible with external modules.

- **Breaking — Draw lifetime:** added terminal `destroy()` / read-only `isDestroyed` to DrawHandler and DrawControl. `remove()` now only detaches and retains features/history; destructive options are rejected. Destroy clears internally owned features but preserves supplied groups. Handler `map` / `mode` are read-only. Map unload, edit-handle disposal, cancelled pointer gestures, reentrant cancellation and toolbar transfers no longer leak listeners or commit stale drafts. Failed control attachment rolls back registration. See [migration](docs/MIGRATION-NEXT-MAJOR.md#draw-lifetime-and-feature-ownership).

- **Breaking — ObjectManager lifetime:** removed overloaded `remove()` in favor of `detach()` / `removeObjects()`. `destroy()` is terminal and idempotent, exposes read-only `isDestroyed`, rejects pending imports even for blocked async iterators, and prevents later data/style/state mutations. Local managers now detach on map unload too. React owns one manager per effect lifetime and releases source subscriptions during Strict Mode cleanup and unmount. See [migration](docs/MIGRATION-NEXT-MAJOR.md#objectmanager-lifetime-and-data-removal).

- **Breaking — remote loading:** `RemoteObjectManager.reload({ signal }?)` now immediately returns a Promise of loaded objects rather than a chainable manager. Cancellation rejects with `AbortError`; automatic loads report events. Viewport changes invalidate active work before debounce, late responses cannot replace newer data/loading state, and destroy prohibits subsequent remote reload/attachment. Map destruction emits `unload` once and detaches remote managers. See [migration](docs/MIGRATION-NEXT-MAJOR.md#remote-viewport-loading).

- **Breaking:** camera, motion, routing and trail time fields now use explicit millisecond names; camera and route seconds must be converted ×1000. Zero-duration object moves no longer fall back to 800 ms. Circles require `{ radiusMeters }` or `{ radiusMapUnits }`, pixel markers use `radiusPixels`, and Draw serializes the selected radius unit. ObjectManager's `clusterGridSize` / setter become `clusterRadiusPixels` / `setClusterRadiusPixels()`. Removed options and invalid units fail early. See [next-major migration](docs/MIGRATION-NEXT-MAJOR.md).

- **Breaking:** geographic/CRS inputs now require `{ lat, lng }` or `LatLng`. Bare tuples are rejected at runtime and by TypeScript, including ObjectManager's mass-point path. GeoJSON keeps `[lng, lat]`; explicit `fromGeoJSONPosition()` and `toGeoJSONPosition()` converters bridge the formats. See [next-major migration](docs/MIGRATION-NEXT-MAJOR.md).

- Geometry worker lifecycle: caller-owned pools are isolated from ObjectManager's internal shared worker, `destroy()` is terminal and rejects pending work with `AbortError`, and worker crashes, message deserialization failures, malformed responses and `postMessage` exceptions now reject affected operations with a contextual `GeometryWorkerError` instead of leaving promises pending. A failed worker is discarded and recreated on the next operation.
- **Breaking — service cancellation:** `SuggestProvider.suggest()` and `RoutingLayer.route()` reject with `AbortError` on cancel/supersession instead of resolving an empty result. Both honor external `AbortSignal`, settle even when a provider ignores cancellation, discard late responses and release listeners. Routing removal cancels pending work while retaining the last successful data. Suggest `destroy()` remains terminal and idempotent; SuggestWidget and the navigation example handle cancellation without displaying a false failure.
- Type safety: exported `PrefetchTileLayerOptions` now represents only valid area inputs—either geographic bounds or both explicit tile axes—and compile-time API contract tests protect this union, the owned geometry-worker factory/error type, and the internal shared-worker boundary.
- Common data model: added the optional zero-dependency `orihon/source` entry with `featureSource()` / `createFeatureSource()` / `FeatureSource`. The read-only structural protocol (`ReadonlyFeatureSource`, versioned snapshots and delta changes) lives in Core types, so renderers do not depend on the implementation entry. Canonical GeoJSON `feature.id` drives `add`, `addMany`, `update`, `remove`, `replace`, `clear` and `batch`. The same source can drive `geoJSON(source)`, `textLayer(source, options)`, Easy `addGeoJSON(source)` and Advanced `objectManager({ source })`; renderer state stays consumer-local, layer subscriptions follow add/remove lifecycle, and ObjectManager stays data-bound until `destroy()`.
- Easy basemaps: `createMap({ basemap })` and `map.setBasemap()` now accept any ready `Layer`, including WMS, WMTS and custom implementations, in addition to raster URL/templates and options. `getBasemap()` returns the original layer, and replacing it removes only the previously managed basemap.
- Size audit: consolidated the shared image/video/SVG overlay lifecycle, embedded-WASM Base64/memory/alignment helpers, DOM/GPU tile-bounds validation, WebGL opacity/distance helpers and the MVT PBF reader used by the feature-level WASM fallback. Removed the redundant `TileLayer.setOpacity()` override while preserving the inherited contract. The npm allowlist now ships documentation pages without internal Confluence/playground source datasets.
- **Breaking — one spelling per style property.** ObjectManager points use `fill` / `fillOpacity` / `size` and managed lines use `stroke` / `strokeOpacity` / `strokeWidth`, consistently across DOM, SVG, WebGL, icon tinting and style-state patches. The former `color` / `opacity` / `width` aliases are **removed**: supplying one now throws `TypeError: color was removed from point styles. Use fill.` rather than silently losing to the canonical field. `MarkerCollection` point options follow the same rule. `marker()`'s own appearance options (`color`, `strokeColor`, `size`, `strokeWidth`) are a separate vocabulary and are unaffected.
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
