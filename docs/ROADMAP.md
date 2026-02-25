# Orihon 1.x enhancement specs

Implementation specs for the gaps identified against Leaflet, OpenLayers, MapLibre GL and Yandex Maps JS API. This is not a commitment to ship every item in one release. Each section is written so it can be implemented and reviewed independently.

Related: [API](API.md) · [PLUGINS](PLUGINS.md) · [SECURITY](SECURITY.md)

## Constraints

These hold for every item below. If a design violates them, change the design.

1. **Gzip budgets stay.** Core ≤ 22 KiB, Standard ≤ 36 KiB, Advanced ≤ 105 KiB (`npm run size`). New surface that would break a budget goes into a **new optional entry** (`orihon/draw`, `orihon/react`, …), not into `orihon/standard` or `orihon`.
2. **Leaflet-like DX.** Factories, `addTo` / `remove`, `on` / `off`, named panes, no required style JSON.
3. **No prototype patching.** Plugins extend `Layer` / `Control` and import only public entries.
4. **Safe content.** Strings are `textContent`. Markup is a `Node`. No `innerHTML`. SVG stays sanitized.
5. **Network is BYO.** Search, routing, geocoding, traffic stay provider-based with `AbortSignal`.
6. **Do not become MapLibre.** No Mapbox Style spec, glyphs/PBF fonts, terrain, globe, or map-level pitch/bearing camera in 1.x.
7. **Do not become OpenLayers.** No Proj4 / arbitrary CRS in core. WMS already speaks `EPSG:3857` and `EPSG:4326` as *request* CRS; the map stays Web Mercator unless `CRS.Simple` is set.
8. **GPU layers assume Mercator.** `webglPointLayer`, `heatLayer`, `tileLayer({ renderer: "webgl"|"auto" })`, `WebGLPathBatch`, ObjectManager WebGL path **throw a typed error** on a Simple-CRS map rather than rendering wrong.

## Packaging

Keep a single npm package. Add optional entries that are **not** in the three gzip budgets:

| Entry | Peer deps | Counted in `npm run size` |
| --- | --- | --- |
| `orihon/core` | — | yes |
| `orihon/standard` | — | yes |
| `orihon` | — | yes |
| `orihon/draw` | `orihon` | no (own budget ≤ 12 KiB gzip) |
| `orihon/react` | `react` ≥ 18, `orihon` | no |

CSS for new controls lives in `orihon.css` under the `oh-*` prefix. Draw-only CSS may ship as `orihon/draw.css` if it would bloat the default sheet.

---

## P0 — product gaps

### P0.1 Draw / Modify / Snap (`orihon/draw`)

**Problem.** Orihon is a viewer. OpenLayers ships Draw/Modify/Snap; Leaflet relies on Geoman / Leaflet.draw. Without this, product maps that create geometries leave.

**Goal.** First-party drawing on Standard vectors (SVG `PathLayer` / `Marker`), as a separate entry so Core/Standard stay small.

**Public API**

```ts
import { drawControl, DrawHandler, type DrawMode } from "orihon/draw";
import "orihon/draw.css";

type DrawMode = "off" | "point" | "polyline" | "polygon" | "rectangle" | "circle" | "edit" | "delete";

const draw = drawControl({
  position: "top-left",
  modes: ["point", "polyline", "polygon", "rectangle", "circle", "edit", "delete"],
  snap: { enabled: true, pixelTolerance: 12, grid: false },
  guide: { stroke: "#0f766e", strokeWidth: 2, dashArray: "6 4" },
  featureGroup: editable // FeatureGroup; created if omitted
}).addTo(map);

draw.setMode("polygon");
draw.undo();
draw.redo();
const geojson = draw.toGeoJSON();
draw.loadData(featureCollection);
```

`DrawHandler` is the headless engine (no control chrome) for apps that build their own toolbar.

**Behavior**

- Click to add vertices. Double-click or Close button finishes polyline/polygon (≥ 2 / ≥ 3 points). Escape cancels the in-progress shape. Enter finishes.
- Rectangle: pointerdown–drag–pointerup. Circle: center click + drag radius (meters via existing `Circle`, not `CircleMarker`).
- Edit: vertex handles + mid-edge insert handles. Drag vertex; Alt-click vertex deletes if count stays legal.
- Delete mode: click a feature in `featureGroup` to remove it.
- Snap: vertices of layers in `featureGroup` (and optional `snapLayers`). Optional pixel grid when `snap.grid` is true.
- Undo/redo: stack of GeoJSON snapshots of `featureGroup`, cap 50. `undo` / `redo` events.
- Keyboard: map `behaviors` stay enabled unless `capturePointer: true` (default while a draw mode is active: disable `dblClick` and `boxZoom`, restore on `off`).

**Events** (`OrihonEvent`)

`drawstart`, `drawvertex`, `drawcomplete` (`{ layer, geojson }`), `editstart`, `editvertex`, `editcomplete`, `deletestart`, `deletecomplete`, `modechange`, `snap`, `undo`, `redo`.

**Locales** — draw UI strings live in `orihon/draw` (`resolveDrawLocale`, nine languages including `drawRedo`), not in core `OrihonLocale`.

**Files (new)**

- `src/draw/handler.ts` — mode state machine
- `src/draw/snap.ts` — pixel-space snap
- `src/draw/handles.ts` — SVG vertex/midpoint markers (`icon({ content })` or SVG circles in overlay pane)
- `src/draw/control.ts` — toolbar `Control`
- `src/draw/index.ts` — public entry
- `test/draw.test.js`

**Acceptance**

- Draw polygon with a hole is **out of scope** for v1 of draw (outer ring only). Holes stay editable if loaded via `loadData`.
- `toGeoJSON()` round-trips Point / LineString / Polygon / rectangle-as-polygon / circle-as-polygon (sampled) or Circle properties (`properties.radiusMeters` on EPSG:3857 or `properties.radiusMapUnits` on CRS.Simple).
- Removing the control calls `onRemove`, restores behaviors, drops handles, and retains features/history. `destroy()` is terminal and clears only internally owned features; supplied groups remain caller-owned. See [Draw lifetime migration](MIGRATION-NEXT-MAJOR.md#draw-lifetime-and-feature-ownership).
- Size: `orihon/draw` ESM gzip ≤ 12 KiB. Core/Standard/Advanced budgets unchanged.
- No `innerHTML` in toolbar; buttons use locale strings.

**Non-goals.** Topology (union/intersect), snapping to tile features, WebGL path editing, turf.

---

### P0.2 Path styling: dash, arrows, geodesic

**Problem.** `PathOptions` is stroke/fill/cap/join only. Leaflet users expect `dashArray`. Large-radius `Circle` is a screen-space ellipse, not a geodesic.

**Goal.** Complete Standard path styling without a new entry. Keep WebGL path batch on a solid stroke (dashed GPU lines are a later Advanced item).

**Public API** — extend `PathOptions` in `src/layers/vector.ts`:

```ts
interface PathOptions {
  // existing…
  dashArray?: string | number[];   // "6 4" or [6, 4]; default none
  dashOffset?: number;             // default 0
  lineJoin?: CanvasLineJoin;
  lineCap?: CanvasLineCap;
  geodesic?: boolean;              // polyline/polygon: great-circle segments
  arrow?: boolean | "end" | "start" | "both";  // polyline only
  arrowSize?: number;              // CSS px, default 10
}
```

`Circle` gains `geodesic?: boolean` (default `false` to preserve current pixel-circle). When true, render as a sampled polygon (32–64 vertices, more at large radius / high zoom) using haversine destination from `center` + `radiusMeters`.

**Implementation notes**

- SVG: `stroke-dasharray`, `stroke-dashoffset`. Arrow: SVG `<marker>` in the layer’s SVG defs, reused per `SvgLayer` instance (not per path) to avoid marker leaks. Sanitize nothing extra — arrows are generated, not user SVG.
- `CanvasPathBatch`: `setLineDash` / `lineDashOffset`. Arrows drawn as two-segment polylines at endpoints. Skip dash if array empty.
- `WebGLPathBatch`: ignore `dashArray` / `arrow` (document it). Solid stroke only. Do not grow the 75 KiB budget for dashed GPU lines in this item.
- `geodesic` on `Polyline`: densify each segment in geographic space before project (`geodesicInterpolate(a, b, maxSegmentMeters)`). Cache densified points; invalidate on `setLatLngs`.
- Circle already uses `metersToPixels` — keep that as the default (`geodesic: false`).

**Files.** `src/layers/vector.ts`, `src/layers/canvas-path-batch.ts`, `src/geo.ts` (`destination`, `geodesicInterpolate`), tests in `test/stage-three.test.js` or `test/path-style.test.js`.

**Acceptance**

- `polyline(points, { dashArray: "8 4", arrow: "end" })` shows dashes and an end arrow after pan/zoom.
- `setStyle({ dashArray: null })` clears dashes.
- `circle(center, 50_000, { geodesic: true })` at 60°N is visibly wider in longitude than the planar circle; `getBounds()` uses geodesic samples.
- Standard gzip still ≤ 36 KiB. If over, drop arrows first (keep dash + geodesic).

**Budget.** Target ≤ 1.5 KiB gzip added to Standard.

---

### P0.3 `CRS.Simple` (indoor / CAD / schemes)

**Problem.** Leaflet `CRS.Simple` covers floor plans and game maps. Orihon hard-codes Web Mercator in `project` / `unproject`.

**Goal.** Map-scoped CRS with two built-ins: `EPSG:3857` (default) and `Simple`. No Proj4.

**Public API**

```ts
import { createMap, CRS, tileLayer } from "orihon/core";

const map = createMap("map", {
  crs: CRS.Simple,           // or "Simple"
  center: ({ lat: 200, lng: 300 }),        // y, x in map units
  zoom: 0,
  minZoom: -5,
  maxZoom: 4
});

// Image overlay in map units:
imageOverlay("floor.png", [({ lat: 0, lng: 0 }), ({ lat: 1000, lng: 1500 })]).addTo(map);
```

```ts
interface CoordinateReferenceSystem {
  readonly code: "EPSG:3857" | "Simple";
  project(latlng: LatLngLike, zoom: number): Point;
  unproject(point: PointLike, zoom: number): LatLng;
  scale(zoom: number): number;
  wrapLng: boolean;          // false for Simple
  wrapLat: boolean;
}
```

**Behavior**

- `LatLng` for Simple is a **coordinate pair**, not WGS84. `distance()` uses Euclidean map units when `map.crs.code === "Simple"`.
- `clampLat` / `MAX_LAT` **must not** run on Simple coordinates (a plan can have y = 4000).
- Tile layers on Simple use the same `{z}/{x}/{y}` math as Leaflet Simple (pixel origin at 0,0, y down). Document that OSM tiles are wrong on Simple maps.
- `fitWorld()` on Simple fits `[[0,0],[TILE_SIZE, TILE_SIZE]]` or `options.maxBounds` if set.
- Advanced GPU layers: if `map.crs.code !== "EPSG:3857"`, `onAdd` throws `Error("WebGL layers require EPSG:3857")`. ObjectManager WebGL path same. DOM ObjectManager on Simple **is** allowed (pixel clustering still works).

**Implementation**

- Stop calling global `project`/`unproject` from `map.ts`; use `this.crs.project`. Keep exported `project`/`unproject` as Mercator helpers for workers and WebGL (unchanged).
- Pass CRS into geometry workers only if we later cluster Simple data; v1 workers stay Mercator-only and refuse Simple.

**Files.** `src/crs.ts` (new), `src/geo.ts` (leave Mercator helpers), `src/map.ts`, `src/layers/tile-layer.ts` (origin), tests `test/crs-simple.test.js`, example under `examples/` CDN demos.

**Acceptance**

- Floor-plan image overlay + markers in pixel coordinates pan/zoom without Mercator distortion.
- Existing Mercator tests unchanged. `createMap` without `crs` is bit-identical in projection.
- Core gzip ≤ 22 KiB. Target add ≤ 1.2 KiB.

**Non-goals.** Custom affine CRS, EPSG:4326 as *map* projection, wrapping worlds on Simple.

---

### P0.4 First-party React bindings (`orihon/react`)

**Problem.** `createMapAdapter` and `orihon-map` Web Component only set center/zoom/controls. Product apps are React.

**Goal.** Declarative layers, strict lifecycle, no React in the Core budget.

**Public API**

```tsx
import { Map, TileLayer, Marker, Popup, GeoJSON, FeatureGroup, ObjectManager } from "orihon/react";
import "orihon/orihon.css";

<Map center={[52.52, 13.405]} zoom={11} locale="ru" style={{ height: 400 }} onClick={handler}>
  <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OSM" />
  <Marker position={[52.52, 13.405]} title="Berlin">
    <Popup>Berlin</Popup>
  </Marker>
  <GeoJSON data={fc} style={style} onEachFeature={onEach} />
</Map>
```

**Rules**

- One `Orihon` instance per `Map`. `useLayoutEffect` create, cleanup `map.remove()`.
- Layer components call `addTo(map)` on mount, `remove()` on unmount, `set*` on prop changes (do not recreate the layer when only style/data changes).
- `Popup` / `Tooltip` as children of a layer use `bindPopup` / `bindTooltip`. String children are text, not HTML.
- Context: `useMap()`, `useMapEvent(type, handler)`.
- `ObjectManager` React wrapper: `objects` prop → `reset`/`add` diff by `id` (not full rebuild if ids unchanged).
- Vue/Svelte are **not** in this item. Document that WC remains the framework-agnostic path.

**Files.** `src/react/*` (or `bindings/react` compiled to `dist/react.js`). Peer `react` and `react-dom` ≥ 18. Types for props mirror existing option interfaces.

**Acceptance**

- Strict Mode double-mount does not leak maps (lifecycle leak test with `map.remove` spy).
- Updating `center`/`zoom` from props calls `setView` and does not reset layers.
- Package export `orihon/react` is tree-shakeable; `orihon` Advanced bundle does not import React.
- Example: `examples/react` (Vite) with Map + GeoJSON + ObjectManager.

**Non-goals.** React Native, SSR map rendering, Vue.

---

## P1 — scale and GIS completeness

### P1.1 Unified `map.query()`

**Problem.** Hit-testing is per renderer: SVG path events, `WebGLPointLayer.hitTestAt`, `ClusterCanvasLayer.queryAt`. Apps cannot ask “what is under this click?” across mixed layers.

**Goal.** One map method that walks layers top-to-bottom (reverse of pane z-order) and returns hits.

**Public API**

```ts
interface QueryHit {
  layer: Layer;
  latlng: LatLng;
  source: "svg" | "dom" | "canvas" | "webgl" | "cluster" | "object";
  id?: string | number;
  index?: number;
  feature?: unknown;
}

interface QueryOptions {
  tolerance?: number;      // CSS px, default 8
  layers?: Layer[];        // default: all interactive
  pane?: string;
  limit?: number;          // default 1 (topmost)
}

map.query(containerPoint: PointLike, options?: QueryOptions): QueryHit[];
map.queryLatLng(latlng: LatLngLike, options?: QueryOptions): QueryHit[];
```

**Layer hook** (opt-in, default none):

```ts
class Layer {
  queryHit?(point: Point, options: Required<QueryOptions>): QueryHit | QueryHit[] | null;
}
```

Implement `queryHit` on `PathLayer`, `Marker`, `CanvasPathBatch` (if `interactive: true`), `WebGLPointLayer`, `ClusterCanvasLayer`, `ObjectManager`.

**Acceptance.** Clicking a stack of polygon + WebGL points + cluster badge returns the topmost by default and all hits when `limit: Infinity`. Layers without `queryHit` are skipped (not errors). Core add ≤ 0.6 KiB; implementations stay in their modules.

---

### P1.2 `textLayer` with collision

**Problem.** Production maps need labels. MapLibre/OL have collision. Orihon only places isoline labels ad hoc (`pickLabelAnchor` in heat isolines).

**Goal.** Canvas (Standard) label layer: point labels + optional line following, greedy collision, no glyph PBF.

**Public API**

```ts
import { textLayer } from "orihon/standard";

textLayer(features, {
  text: (f) => f.properties.name,
  minZoom: 10,
  font: "12px system-ui",
  fill: "#111",
  halo: "#fff",
  haloWidth: 2,
  offset: [0, -8],
  collision: true,          // default true
  collisionPadding: 4,
  placement: "point" | "line",
  maxLabels: 500
}).addTo(map);
```

**Behavior.** One canvas in overlay pane. Rebuild collision on `moveend`/`zoomend` (not every `move` frame). Greedy: higher-priority / larger zoom first; skip overlapping boxes. `placement: "line"` uses the same 40%-along-path idea as isolines. RTL: `direction: inherit` via canvas `textAlign` from map locale when locale is `ar`/`hi` only if we detect RTL locale flag — add `OrihonLocale.rtl?: boolean` or infer from `ar`.

**Reuse.** `src/layers/heat.ts` and `textLayer` share `pickLabelAnchor` from `src/services/label-layout.ts`.

**Acceptance.** 2k labels at z=12: no overlap, pan stays ≥ 50 fps on the bench page’s machine class. Standard budget: if this blows 36 KiB, ship as `orihon` Advanced-only (`textLayer` already conceptually “scale”). Prefer Advanced if > 2 KiB gzip.

**Non-goals.** MapLibre `symbol-sort-key` expressions, Chinese glyph shaping beyond the system font, 3D pitch.

---

### P1.3 MVT paint style (not Style spec)

**Problem.** `vectorTileLayer` + `createMVTProvider` decode to GeoJSON and style via GeoJSON callbacks. That is slow and verbose for tiled basemaps. MapLibre Style spec is too large.

**Goal.** Declarative paint for decoded MVT **without** expressions language v8.

**Public API**

```ts
vectorTileLayer({
  provider: createMVTProvider("/tiles/{z}/{x}/{y}.pbf"),
  paint: [
    { layer: "water", type: "fill", fill: "#a0c8f0", fillOpacity: 0.8 },
    { layer: "roads", type: "line", stroke: "#fff", strokeWidth: 1.5, minZoom: 8 },
    { layer: "places", type: "circle", radius: 3, fill: "#111", minZoom: 12 }
  ],
  interactive: false
});
```

Filter is a **predicate**, not an expression AST: `filter: (feature) => feature.properties.class !== "ferry"`.

**Renderer.** Prefer `CanvasPathBatch` / circle batch per tile (already GeoJSON canvas). Optional WebGL path when `renderer: "webgl"` and Advanced. Do not parse `layout`/`paint` JSON from Mapbox.

**Acceptance.** A single OpenMapTiles-style layer list renders water + roads at z=10 without per-feature SVG. `style` callback still wins if both `style` and `paint` are set (`style` documented as override). Advanced gzip: target ≤ 1.5 KiB add.

---

### P1.4 PMTiles + WMTS

**PMTiles**

```ts
import { createPMTilesProvider } from "orihon";

vectorTileLayer({
  provider: createPMTilesProvider("/city.pmtiles", { layer: "roads" })
}).addTo(map);

tileLayer.pmtiles?. // raster archives: createPMTilesRasterSource(url) → TileLayer url function
```

Use a **minimal** PMTiles v3 reader (header + directory + tile fetch), not the full `pmtiles` npm (keep zero runtime deps). If the spec reader exceeds ~4 KiB gzip, ship `orihon/pmtiles` as an optional entry.

**WMTS**

```ts
wmtsTileLayer(capabilitiesUrl | template, {
  layer: "orto",
  tileMatrixSet: "EPSG:3857",
  format: "image/png",
  style: "default"
});
```

v1: **template-only** WMTS (`{TileMatrix}/{TileCol}/{TileRow}`), plus optional `createWMTSFromCapabilities(xml: string)` parser for GetCapabilities (KVP). REST encoding. Web Mercator tile matrix only (align with map CRS). No other matrices until CRS work exists.

**Acceptance.** Template WMTS against a known public endpoint; PMTiles fixture in `test/fixtures/tiny.pmtiles`. Abort in-flight via existing tile `signal`. `urlPrefixes` / offline cache work because URLs are normal HTTPS.

---

### P1.5 ObjectManager cluster UX (spiderfy / expand)

**Problem.** `clusterZoomOnClick` zooms in. Leaflet.markercluster also spiderfies at `clusterMaxZoom`, which is the expected “see the points” gesture.

**Public API** — extend `ObjectManagerOptions`:

```ts
{
  clusterZoomOnClick?: boolean;     // existing
  spiderfyOnMaxZoom?: boolean;      // default true
  spiderfyDistanceMultiplier?: number; // default 1
  zoomToBoundsOnClick?: boolean;    // default true (today’s zoom-in)
}
```

**Behavior.** If `zoom < clusterMaxZoom` and `zoomToBoundsOnClick`, `fitBounds` of members (already roughly this). If at max zoom (or cannot zoom further), **spiderfy**: place members on a circle/spiral in overlay pane, polylines back to centroid, click map to unspiderfy. Only one spiderfy group at a time.

Works for both DOM badges and `ClusterCanvasLayer.queryAt` clicks.

**Acceptance.** 12-point cluster at max zoom fans out; second cluster click replaces the first; `remove()` / filter clears spiderfy. Advanced add ≤ 1.2 KiB gzip.

---

## P2 — perceived completeness

### P2.1 Small controls

Ship in Standard if they fit the 36 KiB budget; otherwise `orihon` Advanced or tiny plugins.

| Control | API | Notes |
| --- | --- | --- |
| Fullscreen | `fullscreenControl()` | Fullscreen API on `map.container`. Locale `fullscreen` / `exitFullscreen`. Fallback: CSS class `oh-map-expanded` on a wrapper if API missing. |
| Measure | `measureControl()` | Polyline distance via existing `distance()`. Live tooltip. `geodesic: true` uses P0.2 helper. |
| Mini map | `miniMap(layer, { zoomOffset: -4 })` | Second `Orihon` instance, sync `moveend`, rectangle of parent viewport. Cheap but two maps — keep layer factory, not a clone of all layers. |
| Graticule | `graticuleLayer({ step?: number \| "auto" })` | SVG meridians/parallels. Skip on Simple CRS unless `units: "map"`. |

Priority order if budget is tight: **measure → fullscreen → graticule → mini map**.

### P2.2 Export / print

```ts
map.exportPng({ pixelRatio?: number, includeControls?: boolean }): Promise<Blob>
```

Draw: tiles (from loaded img/canvas), then overlay canvases, then SVG via `XMLSerializer` + `drawImage`. DOM markers via `html2canvas`-free path: skip or draw icon images only. Document that HTML `DivIcon` / popups are omitted unless `includeControls` and we rasterize via SVG foreignObject (**do not** — XSS). So: **tiles + SVG/canvas/WebGL canvases + marker <img>**. No arbitrary HTML.

Print: `map.print()` opens a window with the PNG and `window.print()`.

### P2.3 Plugin catalog and `orihon/geo`

- Expand [PLUGINS.md](PLUGINS.md) with a registry table (name, entry, size, peer). First-party plugins: draw, react, pmtiles.
- `orihon/geo` is **not** a Turf fork. It re-exports `destination`, `geodesicInterpolate`, `distance`, plus optional `bufferPoint` if tiny. For union/simplify, document Turf as the app-level tool and a recipe: `geoJSON(turf.buffer(...))`.

### P2.4 Marker rotation and DivIcon completeness

Small Standard fix, can ride with P0.2:

```ts
marker(latlng, { rotation: 45, rotationOrigin: "center bottom" })
```

CSS `transform` already used for positioning — compose rotate. Keep `draggable` working (rotation is visual only).

---

## Suggested implementation order

Do not start P1 GPU/MVT work before P0. Draw and React are what unblock adoption; path style and CRS.Simple are cheap and expected.

| Sprint | Items | Why this order |
| --- | --- | --- |
| 1 | P0.2 path style + marker rotation | Tiny, unblocks dash/arrows, warms `PathOptions` |
| 2 | P0.3 CRS.Simple | Unblocks indoor; forces map-scoped projection (needed anyway) |
| 3 | P0.1 `orihon/draw` | Depends on dash/geodesic for guides and circles |
| 4 | P0.4 `orihon/react` | Can start in parallel with 3 |
| 5 | P1.1 `map.query()` | Draw edit and mixed layers need it |
| 6 | P1.5 spiderfy | ObjectManager UX; uses query |
| 7 | P1.3 MVT paint + P1.4 WMTS template | GIS completeness |
| 8 | P1.2 textLayer, P1.4 PMTiles | Heavier; optional entries if size slips |
| 9 | P2 controls + export | Tender checkboxes |

## Explicitly out of 1.x core

| Idea | Why not |
| --- | --- |
| MapLibre Style spec, glyphs, terrain, globe, map pitch/bearing | Different renderer; blows 75 KiB; breaks DOM ObjectManager |
| Proj4 / arbitrary map CRS | OpenLayers territory |
| Bundled geocoder / router / traffic tiles | No data business; keep providers |
| Street panoramas | Needs imagery provider |
| Dashed WebGL paths, GPU labels | After canvas textLayer proves the API |
| Vue / Svelte first-party | After React |

## Test and demo checklist (every item)

- Unit tests in `test/` with the existing Node harness.
- `npm run size` on Core / Standard / Advanced (and the new entry’s own budget).
- Scale showcase under `examples/showcase` (tier unfold + stress scenes) and the engine bench under `examples/bench-compare`.
- API.md + CHANGELOG Unreleased notes.
- Security: no new `innerHTML`, draw handles are DOM nodes, export does not rasterize arbitrary HTML.
