<p align="center">
  <img src="./assets/brand/svg/orihon-logo-horizontal.svg" alt="Orihon — folded map and route logo" width="520" />
</p>

# Orihon

**ORIHON — Offers Responsive Interactions, Handles Overlays Natively.**

[![npm](https://img.shields.io/npm/v/orihon?color=0f766e)](https://www.npmjs.com/package/orihon)
[![downloads](https://img.shields.io/npm/dm/orihon?color=0f766e)](https://www.npmjs.com/package/orihon)
[![CI](https://github.com/whahedev/orihon/actions/workflows/ci.yml/badge.svg)](https://github.com/whahedev/orihon/actions/workflows/ci.yml)
[![full size](https://img.shields.io/badge/full-≤75_KiB_gzip-0f766e)](https://github.com/whahedev/orihon#tiers)
[![license](https://img.shields.io/badge/license-Apache%202.0-0f766e)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178c6)](./tsconfig.json)

Production-ready SVG/PNG logos, favicons and design tokens are published under [`orihon/brand/*`](./docs/BRAND.md).

## Unfold the world.

Orihon is a free, open-source browser map engine. Apache 2.0. Use it anywhere.

Want to build visually? Try Orihon Studio.

Orihon is a lightweight, high-performance mapping library built around a simple idea:

**less weight, more space.**

Inspired by the Japanese folding book, Orihon treats the map as a continuous surface — compact in form, boundless when unfolded.

Layers appear.  
Geometry moves.  
Surfaces connect.  
The world keeps unfolding.

At less than **75 KiB gzipped**, Orihon stays small where it matters — without sacrificing speed or capability.

In benchmarks, Orihon outperforms Leaflet, OpenLayers, and MapLibre, delivering faster rendering and interaction while keeping the core remarkably compact.

No unnecessary weight.  
No artificial boundaries.  
No complexity for complexity’s sake.

Just a fast, continuous canvas for building maps.

**Orihon — small in size, boundless in space.**

Use the tiny core for simple maps. Add everyday GIS in Standard (still **no WebGL**). Pull Advanced (`orihon`) only when volume or camera stress needs GPU — points, heat, GL tiles, GL GeoJSON lines.

## Install

```sh
npm install orihon
```

Coordinate order is explicit when you need it:

```ts
const moscow = latLng(55.751244, 37.618423); // latitude, longitude
const berlin = lngLat(13.405, 52.52);        // longitude, latitude (MapLibre / GeoJSON order)

marker(berlin).addTo(map);
```

Development and release tooling requires **Node.js 22 or newer**; the repository pins **Node.js 24.19.0 LTS** in `.node-version`. Browser consumers are unaffected by this build-time requirement.

## Package complexity: tiers

Orihon is built as three intentional surfaces. Start narrow; grow only when the product needs it.

| Tier | Import | What you get |
| --- | --- | --- |
| **Core** | `orihon/core` | Map, events, geometry, DOM tiles, grid |
| **Standard** | `orihon/standard` | Core + markers, SVG/canvas vectors, GeoJSON (`svg`/`canvas`), popups, controls, overlays, locales — **no WebGL** |
| **Advanced** | `orihon` | Standard + WebGL (points, heat, path batch, raster tiles), MVT, ObjectManager, routing, traffic, offline, workers, adapters |

Optional entries keep product-specific integrations outside those tier budgets: `orihon/easy`, `orihon/source`, `orihon/draw`, `orihon/react`, `orihon/pmtiles`, `orihon/mlt` (MLT **encoder**), `orihon/mvt-wasm` / `orihon/webgpu` (Standard-only opt-in), `orihon/controls`, `orihon/geo` and `orihon/popup-content`.

## API complexity

Package size and API difficulty are separate axes:

| API level | Intended use |
| --- | --- |
| **Easy** | A Standard-powered adapter for first maps: options create a basemap and map methods add common objects. |
| **Layer API** | Explicit composition with `tileLayer()`, `marker()`, `geoJSON()` and other layers. |
| **Rendering API** | Backend selection, packed data, workers, WebGL/WebGPU and renderer diagnostics. |

```js
import { createMap } from "orihon/easy";

const map = createMap("map", {
  center: { lat: 55.751244, lng: 37.618423 },
  zoom: 12,
  basemap: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors"
  }
});

map.addMarker({
  position: { lat: 55.751244, lng: 37.618423 },
  popup: "Москва"
});

map.addPolyline(route, { stroke: "#2563eb" });
map.addPolygon(district, { fill: "#2563eb", fillOpacity: 0.2 });
map.addGeoJSON(places);
map.addTileLayer("https://example.test/{z}/{x}/{y}.png");

// The same Easy surface can be configuration-driven:
const routeLayer = map.add({
  type: "polyline",
  coordinates: route,
  style: { stroke: "#2563eb", width: 4, opacity: 0.8 }
});
```

`orihon/easy` supports one discriminated `map.add(description)` contract for `marker`, `polyline`, `polygon`, `geojson` and `raster`, which maps naturally to React/Vue/Svelte props and configuration. The returned layers are normal Standard objects. `basemap` / `setBasemap()` accept either raster configuration or any ready `Layer`, including WMS, WMTS and custom implementations. Every map also accepts an already-created layer through `map.add(layer)`, while `layer.addTo(map)` remains unchanged. A MapLibre-style `addSource()` is deliberately deferred until Orihon has a real named, reusable source lifecycle instead of disguising a layer as a source. See the [Easy API guide](./docs/EASY.md).

For data reused by several renderers, `orihon/source` provides a small reactive `FeatureSource`. One source can drive `geoJSON`, `textLayer` and `ObjectManager`, so an application can change rendering strategy without replacing its update model. Consumers depend only on the read-only structural protocol exported from Core; mutation, batching and storage remain optional. See the [FeatureSource guide](./docs/FEATURE_SOURCE.md).

**GPU policy:** Core/Standard stay CPU/DOM. Advanced opts into GPU only where dataset size or continuous camera stress pays for it (`webglPointLayer`, `heatLayer({ backend: "auto" })`, `tileLayer({ renderer: "webgl"|"webgpu"|"auto" })`, `geoJSON({ renderer: "webgl" })` / `auto` on large path sets). `tileLayer({ renderer: "auto" })` uses the unified GPU tile pipeline: WebGPU when available, then WebGL, then DOM. Normal vector-tile applications use `createMVTProvider` / `decodeMVT`; low-level packed decoding is isolated in `orihon/mvt`.

```js
// Core — basemap only
import { createMap, tileLayer } from "orihon/core";

// Standard — everyday GIS UI (SVG/canvas GeoJSON)
import { createMap, tileLayer, marker, geoJSON, zoomControl } from "orihon/standard";

// Advanced — GPU when volume / camera stress needs it
import { createMap, objectManager, webglPointLayer, geoJSON, createMVTProvider, tileLayer } from "orihon";

tileLayer(url); // auto: WebGPU → WebGL → DOM
createMVTProvider("/tiles/{z}/{x}/{y}.pbf"); // MVT, MLT, WASM — same call

// Product integrations stay separate
import { drawControl } from "orihon/draw";
import { Map, TileLayer, Marker, Popup } from "orihon/react";
import { createPMTilesProvider } from "orihon/pmtiles";
import { encodePackedMLT } from "orihon/mlt"; // encoder only
import { fullscreenControl, measureControl, miniMap, graticuleLayer } from "orihon/controls";
import { bufferPoint } from "orihon/geo";
```

Gzip budgets stay attached to the tiers: core ≤ 22 KiB, standard ≤ 36 KiB, full (Advanced + WebGL/WebGPU) ≤ 105 KiB. Prefer the smallest entry that covers the feature set.

**ObjectManager** is the Advanced-tier answer to heavy datasets: render and manage 100,000+ map objects without keeping 100,000 DOM markers alive.

For 100k–1M imports, prefer `await manager.addAsync(iterable, { chunkSize: 10_000, yieldMode: "task" })`. It accepts synchronous or asynchronous iterables, reports progress, supports `AbortSignal`, and coalesces layout invalidation until the import finishes. `add()` remains the fastest synchronous path for bounded inputs.

## Quick Start

```js
import { createMap, tileLayer, marker, polyline } from "orihon";
import "orihon/orihon.css";

const map = createMap("map", {
  center: ({ lat: 52.520008, lng: 13.404954 }),
  zoom: 10
});

tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "\u00a9 OpenStreetMap contributors"
}).addTo(map);

marker(({ lat: 52.520008, lng: 13.404954 }), { title: "Berlin" }).addTo(map);

polyline([
  ({ lat: 52.51, lng: 13.37 }),
  ({ lat: 52.53, lng: 13.41 }),
  ({ lat: 52.50, lng: 13.44 })
], { stroke: "#0f766e", strokeWidth: 4 }).addTo(map);
```

Script-tag / CDN build:

```html
<link rel="stylesheet" href="./node_modules/orihon/dist/orihon.css" />
<script src="./node_modules/orihon/dist/orihon.global.js"></script>
<script>
  const map = Orihon.createMap("map", { center: [52.52, 13.405], zoom: 10 });
</script>
```

## What Is Included

### Core

- Web Mercator map: pan, wheel zoom, touch pinch, double-click zoom, box zoom, inertia and navigation helpers.
- Events (`OrihonEvent`), typed geometry (`Point`, `Bounds`, `LatLng`, `LatLngBounds`) and projection helpers.
- Grid and tile layers with stable generations, bounded DOM reuse, TMS, Retina and source bounds.
- Familiar map API: `addTo`, `remove`, `setView`, `panTo`, `fitBounds`, `flyTo`, `on`, `off`.

### Standard

Everything in Core, plus:

- Markers, icons / `DivIcon`, SVG polylines, polygons with holes, rectangles, circles and circle markers.
- GeoJSON with `filter`, `style`, `pointToLayer`, `onEachFeature`.
- Popups and tooltips (`bindPopup`, `bindTooltip`, auto-pan).
- Image / video / SVG overlays, WMS and WMTS tiles, canvas labels with collision, canvas base layer, `LayerGroup` / `FeatureGroup`.
- Zoom, scale, attribution, geolocation, layers and custom controls with locales (`en`, `ru`, `ar`, `tr`, `zh`, `de`, `fr`, `da`, `hi`).

### Advanced

Everything in Standard, plus:

- `MarkerCollection` — viewport-culled, recycled HTML markers; `renderer:"svg"` with one real SVG circle per point, shared group style/camera transform, spatially distributed HTML buttons (`htmlButtonLimit` + `buttonCellSize`) and selected-object priority through `setSelected()`; automatic WebGL from 2,500 points; or `renderer:"hybrid"` with bounded HTML over a WebGL remainder. Internal marker nodes stay out of the map-wide frame loop.
- `ObjectManager` / `RemoteObjectManager` — high-volume collections with viewport DOM, clustering and stale-request cancellation.
- `WebGLPointLayer`, unified `HeatLayer` / `heatLayer()` / `buildHeat()` (continuous heat, WASM isolines, or both from one scalar field), and MVT-capable `VectorTileLayer`. The former Canvas heat, point-splat WebGL heat and standalone isoline layers have been removed.
- Provider-based search, suggest, routing and traffic.
- Offline tile cache / Service Worker helpers, geometry workers, performance inspector and framework / Web Component adapters.

Runtime profile across tiers: reusable DOM panes, tile cache limits, SVG path reuse, spatial grid queries and differential marker rendering.

## TypeScript

The source is strict TypeScript. `npm run build` writes ESM modules, source maps and generated declarations to `dist`.

Use named imports:

```js
import { createMap, tileLayer, marker, featureGroup, circle, rectangle, layersControl } from "orihon";
import "orihon/orihon.css";

const map = createMap("map", { center: ({ lat: 52.52, lng: 13.405 }), zoom: 10 });
const streets = tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
const places = featureGroup([
  marker(({ lat: 52.52, lng: 13.405 })).bindPopup("Berlin"),
  circle(({ lat: 52.54, lng: 13.43 }), 750),
  rectangle([({ lat: 52.49, lng: 13.35 }), ({ lat: 52.54, lng: 13.45 })])
]).addTo(map);

map.fitBounds(places.getBounds());
layersControl({ Streets: streets }, { Places: places }).addTo(map);
```

## ObjectManager

Render and manage 100,000+ map objects without keeping 100,000 DOM markers alive.

```js
import { createMap, objectManager, tileLayer } from "orihon";
import "orihon/orihon.css";

const map = createMap("map", { center: ({ lat: 55.75, lng: 37.62 }), zoom: 11 });
tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

const manager = objectManager({
  clusterize: true,
  clusterGridSize: 60,
  clusterRenderer: "auto",
  layoutWorker: "auto"
}).addTo(map);

await manager.addAsync(
  Array.from({ length: 50_000 }, (_, id) => ({
    type: "Feature",
    id,
    geometry: {
      type: "Point",
      coordinates: [37.4 + Math.random() * 0.5, 55.6 + Math.random() * 0.3]
    },
    properties: { name: `Point ${id}` }
  })),
  { chunkSize: 10_000, yieldMode: "task" }
);
```

### Object state and data-driven styling

`ManagedObject.properties` stores durable object data. Runtime UI/application flags live separately in `ObjectState` (selected, hovered, alarms, etc.) and are never written back into `properties`.

```js
const manager = objectManager({
  clusterRenderer: "auto",
  style: (object, state, context) => ({
    fill:
      context.selected
        ? "#7c3aed"
        : context.hovered
          ? "#f59e0b"
          : state.alarm === true
            ? "#dc2626"
            : object.properties?.status === "offline"
              ? "#64748b"
              : "#16a34a",
    fillOpacity: state.disabled === true ? 0.3 : 0.9,
    size: context.zoom >= 14 ? 13 : 7
  })
});

manager.setObjectState("truck-42", { alarm: true });
manager.setSelected("truck-42");
```

Point styles use the same vocabulary as vector fills: `fill`, `fillOpacity`, `size`. The former `color` and `opacity` names remain compatibility aliases; canonical fields win when both are present. Style priority: base defaults → legacy category/alert/selected/hover (`styleByCategory`) → custom `style` → normalization. Custom resolvers are not auto-wrapped with purple/orange selection colors — use `context.selected` / `context.hovered` explicitly. `setObjectState` shallow-merges scalars (`undefined` deletes a key; `null` is kept). Batch updates use `setObjectStates`. Changing state patches only touched WebGL color/size slots when the GPU buffer topology is unchanged. `clear()` clears object data and states but keeps the configured style resolver.

### Managed geometries, icons, labels, and scene modes

Points use `coordinates: { lat, lng }`. GeoJSON-style `geometry` accepts `Point` (`[lng, lat]`), `LineString`, and `Polygon` in one manager. Bare coordinate tuples are no longer accepted outside GeoJSON; see [next-major migration](docs/MIGRATION-NEXT-MAJOR.md).

```js
const manager = objectManager({
  clusterize: true,
  visualization: "auto",
  visualizationByZoom: { heatmapUntil: 7, clustersUntil: 12 },
  declutter: true,
  search: { fields: ["properties.name", "properties.vehicleNumber"] },
  time: {
    value: (object) =>
      typeof object.properties?.timestamp === "number"
        ? object.properties.timestamp
        : null
  },
  clusterProperties: {
    alarms: {
      operation: "count",
      filter: (object) => object.properties?.alarm === true
    },
    totalCargo: {
      operation: "sum",
      value: (object) => Number(object.properties?.cargo ?? 0)
    }
  },
  style: (object, state, context) => ({
    fill: state.selected ? "#7c3aed" : state.alarm ? "#dc2626" : "#2563eb",
    fillOpacity: 0.9,
    size: context.zoom >= 14 ? 18 : 12,
    icon: object.properties?.type === "truck" ? "truck" : null,
    rotation: Number(object.properties?.heading ?? 0),
    label:
      context.zoom >= 13
        ? {
            text: String(object.properties?.name ?? ""),
            fontSize: 12,
            haloColor: "#ffffff",
            haloWidth: 2,
            offset: [0, -20],
            priority: state.selected ? 1000 : 0
          }
        : null,
    trail:
      object.properties?.type === "truck"
        ? { enabled: true, maxPoints: 40, color: "#2563eb", width: 2, opacity: 0.5 }
        : null,
    line: object.geometry?.type === "LineString"
      ? { stroke: "#2563eb", strokeWidth: 3, dashArray: [8, 4] }
      : undefined,
    polygon: object.geometry?.type === "Polygon"
      ? { fill: "#0f766e", fillOpacity: 0.2, stroke: "#0f766e", strokeWidth: 1.5 }
      : undefined
  })
});

manager.registerIcon("truck", truckImage);
manager.add([
  {
    id: "truck-42",
    geometry: { type: "Point", coordinates: [37.618423, 55.751244] },
    properties: { type: "truck", name: "Truck 42", heading: 90, timestamp: Date.now() }
  }
]);
manager.updateObject("truck-42", { coordinates: ({ lat: 55.76, lng: 37.63 }) }, { animate: true, duration: 800 });
manager.search("truck 42", { limit: 10 });
manager.setTimeRange(Date.now() - 3600_000, Date.now());
```

**Icons:** GPU sprite atlas rebuilt only on `registerIcon` / `removeIcon` / `clearIcons` — not on object moves. Missing icons fall back to a default symbol. Tint uses `iconTint` when set, otherwise point `fill` (or legacy `color`).

**Rotation:** degrees (`0` up, `90` right). Per-instance GPU attribute on symbol quads (`rotationAlignment: "screen"` in v1).

**Labels / declutter:** `style.label` plus optional `declutter: true`. Higher `priority` wins; `collisionMode: "always"` bypasses declutter (selected/hovered default to always).

**Visualization:** `"objects" | "clusters" | "heatmap" | "auto"`. Switching modes keeps `ObjectState`, search, and temporal indexes.

**Search / time:** opt-in local token index and temporal range filter. Coordinate/state updates do not rebuild search; time filtering applies before clustering/heatmap.

**Motion / trails:** `updateObject(..., { animate: true })` / `moveObject`. Spatial index uses target coordinates; symbol rendering can interpolate. Trails append on logical moves and batch-render with styled paths.

**Lines / polygons:** managed geometries route to path/polygon batches. Dash + gradient are supported on the styled path pipeline (canvas-backed with distance-along-line data; WebGL shaders are the next hardening step). Style-only updates avoid retriangulation when geometry is unchanged.

## GeoJSON And WMS

GeoJSON supports every standard geometry, polygon holes and the familiar callbacks `filter`, `style`, `pointToLayer` and `onEachFeature`. Vector rendering performs viewport culling and zoom-level simplification for large paths. Data can be appended, restyled, reset and exported without rebuilding the map:

```js
const data = geoJSON(featureCollection, {
  filter: (feature) => feature.properties?.visible !== false,
  style: (feature) => ({ stroke: feature.properties?.color }),
  pointToLayer: (feature, position) => circleMarker(position, { radius: 7 }),
  onEachFeature: (feature, layer) => layer.bindPopup(feature.properties?.title)
}).addTo(map);

data.addData(nextFeature).setStyle({ strokeWidth: 4 });
const snapshot = data.toGeoJSON();
data.resetStyle();
```

Large inputs have a responsive asynchronous path. A raw JSON `string` or `Blob` is parsed in a dedicated Worker when the browser permits it; a parsed object is consumed on the main thread in bounded chunks, avoiding a second full structured clone. `AsyncIterable<GeoJSONData>` is accepted for application-owned streaming:

```js
const controller = new AbortController();
const lines = geoJSON(null, {
  renderer: "webgl",
  interactive: false,
  retainFeatures: false,
  maxFeatures: 1_000_000
}).addTo(map);

await lines.addDataAsync(fileBlob, {
  chunkSize: 5_000,
  maxBytes: 256 * 1024 * 1024,
  signal: controller.signal,
  onProgress: (processed, total) => console.log(processed, total)
});
```

`addDataAsync()` accepts parsed GeoJSON, raw JSON text/Blob, or an async stream. Its defaults are `chunkSize:5000`, `useWorker:true`, `yieldMode:"frame"` and a 256 MiB raw-input limit. If Blob workers are unavailable (for example because of CSP), parsing falls back to the main thread while ingestion remains chunked. `yieldMode:"task"` is useful before a map is attached or in a background import workflow.

For write-once, non-interactive path sets at hundreds of thousands to millions of features, combine `addDataAsync()` with `renderer:"webgl"` and `retainFeatures:false`. This keeps only the packed path buffer; discarded features are intentionally unavailable through `toGeoJSON()` or later per-feature restyling. During continuous pan/zoom, the WebGL path batch camera-warps its last exact frame and throttles full GPU redraws; an exact frame is rendered after the camera settles. Direct `pathBatch({ mode:"uniform" })` users can tune `cameraRedrawInterval` (default 250 ms; `0` restores every-frame redraw) and `cameraSettleDelay` (default 120 ms).

WMS GetMap URLs are generated per tile with WMS 1.1.1 or 1.3.0 axis ordering and either `EPSG:3857` or `EPSG:4326` bounds:

```js
const districts = wmsTileLayer("https://maps.example.test/wms", {
  layers: "public:districts",
  format: "image/png",
  transparent: true,
  version: "1.3.0",
  crs: "EPSG:3857"
}).addTo(map);

districts.setParams({ styles: "selected" });
```

Custom tile grids use the `GridLayer` extension class; media overlays expose the normal layer lifecycle:

```js
class CustomTiles extends GridLayer {}
videoOverlay("traffic.mp4", [({ lat: 52.48, lng: 13.30 }), ({ lat: 52.55, lng: 13.45 })], { poster: "preview.png" }).addTo(map);
svgOverlay(document.querySelector("svg"), [({ lat: 52.48, lng: 13.30 }), ({ lat: 52.55, lng: 13.45 })]).addTo(map);
```

## Rich Popup Content

Every interactive layer accepts text, numbers, DOM nodes, async factories or mountable component objects. Mountable content is useful for charts and framework roots because Orihon calls its cleanup when the popup closes:

```js
marker(({ lat: 52.52, lng: 13.405 }))
  .bindPopup(({ data }) => ({
    mount(container) {
      const canvas = document.createElement("canvas");
      container.append(canvas);
      const chart = new Chart(canvas, {
        type: "bar",
        data: data.chartData
      });
      return () => chart.destroy();
    }
  }), { className: "analytics-popup" })
  .addTo(map);
```

The factory context contains `map`, `latlng`, `source`, `event` and `data`. An `HTMLElement`, `<img>` or `<video controls>` can be returned directly. Strings are inserted as text, not interpreted as HTML.

Collections expose object-aware factories:

```js
objects.bindPopup((object, id, context) => renderObjectCard(object, context));
objects.bindClusterPopup((items, ids) => renderClusterChart(items));

geoJSON(data, {
  popup: (feature) => renderFeatureCard(feature)
});

webglPointLayer(points)
  .bindPopup(({ event, data }) => renderPointCard(data, event.index));
```

Calling `bindPopup` automatically enables click handling for WebGL points and image/video/SVG overlays.

## UI And Localization

Built-in UI locales (English is the default): `en`, `ru`, `ar`, `tr`, `zh`, `de`, `fr`, `da`, `hi`. Controls inherit the map locale; individual controls can override it. Presets are also exported as `enLocale`, `ruLocale`, `arLocale`, and so on, plus a `locales` map. The scale supports metric, imperial or combined units, and custom controls accept text, DOM nodes or a render callback without using `innerHTML`:

```js
const map = createMap("map", {
  center: ({ lat: 52.52, lng: 13.405 }),
  zoom: 10,
  locale: "de",
  ariaLabel: "Objektkarte"
});

scaleControl({ units: "both" }).addTo(map);
customControl((currentMap) => `z${currentMap.getZoom()}`, {
  position: "bottom-left",
  ariaLabel: "Aktueller Zoom"
}).addTo(map);

const place = marker(({ lat: 52.52, lng: 13.405 }), { opacity: 0.8, zIndexOffset: 100 })
  .bindPopup("Objekt", { autoPan: true, keepInView: true })
  .addTo(map);
```

## Services And Behaviors

The services layer stays provider-based: Orihon owns orchestration, cancellation and display, while an app can plug in local or commercial data providers.

```js
const search = searchProvider([
  { name: "Berlin", center: ({ lat: 52.520, lng: 13.405 }) },
  { name: "Hamburg", center: ({ lat: 53.551, lng: 9.994 }) }
]);

createSuggestWidget({
  input: document.querySelector("#search"),
  provider: createSuggestProvider((query, context) => search.search(query, context)),
  label: (item) => item.name,
  onSelect: (item) => map.setView(item.center, 11)
});

const routes = routingLayer({
  provider: createStraightLineRoutingProvider(),
  alternatives: true
}).addTo(map);

await routes.route([({ lat: 52.52, lng: 13.40 }), ({ lat: 52.55, lng: 13.45 })]);
routes.select(1);

const traffic = trafficLayer("/traffic/{z}/{x}/{y}.png").addTo(map);
traffic.on("statechange", ({ state }) => console.log(state));
traffic.refresh();

map.behaviors.disable("scrollZoom");
map.behaviors.enable("dblClick");
```

## Advanced Modules

Orihon 1.0 keeps advanced modules opt-in for large datasets and production diagnostics without making the everyday map heavier.

Scale showcase: [`examples/showcase`](examples/showcase) — Core → Standard → Advanced, then 100k+ stress scenes (open `index.html`, or [live](https://whahedev.github.io/orihon/showcase/)). Comparative engine bench: [`examples/bench-compare`](examples/bench-compare) — same point workload across Orihon, Leaflet, OpenLayers and MapLibre (open `index.html`, or [live](https://whahedev.github.io/orihon/bench/)).

```js
const points = webglPointLayer([], {
  pointSize: 4,
  color: "#e11d48"
}).addTo(map);

await points.setDataAsync(bigPointArray, {
  chunkSize: 50_000,
  yieldMode: "task"
});

const heat = heatLayer(weightedPoints, {
  mode: "both",             // "heatmap" | "isolines" | "both"
  backend: "auto",          // "auto" | "wasm" | "webgpu"
  evaluation: "static",     // full dataset; use "zoom" for local refinement
  labels: true,
  step: "auto",             // spatially adaptive levels; or an absolute interval
  bands: true,               // fill every contour zone, including edges
  cover: true,
  interactive: true          // line/zone hover, click, query and selection
}).addTo(map);

heat
  .bindTooltip(({ data }) => data.kind === "line"
    ? `Contour ${data.value}`
    : `Zone ${data.lowerValue}–${data.upperValue ?? "∞"}`)
  .bindPopup(({ data }) => JSON.stringify(data));

heat.on("select", ({ feature }) => console.log("selected", feature));
heat.on("contextmenu", ({ feature }) => openAnalysisMenu(feature));
heat.clearSelection();

// The same feature is available through the common map query API.
const hit = map.query([320, 240], { layers: [heat] })[0]?.feature;

// The same flags work on ObjectManager's packed 100k–1M heat visualization.
const sensors = objectManager({
  visualization: "heatmap",
  heatmapDisplay: "both",
  heatmapBackend: "auto",
  heatmapEvaluation: "static",
  heatmapIsolineLabels: true,
  heatmapIsolineStep: 0.25,
  heatmapWeight: (object) => Number(object.properties?.value ?? 1)
}).addTo(map);

const vectorTiles = vectorTileLayer({
  provider: async ({ x, y, z, signal }) => {
    const response = await fetch(`/tiles/${z}/${x}/${y}.json`, { signal });
    return response.json();
  },
  style: (feature) => ({ stroke: feature.properties.color })
}).addTo(map);

const mvtProvider = createMVTProvider("/mvt/{z}/{x}/{y}.pbf", { layer: "roads" });
vectorTileLayer({
  provider: mvtProvider,
  renderer: "canvas",
  paint: [
    { layer: "water", type: "fill", fill: "#a0c8f0" },
    { layer: "roads", type: "line", stroke: "#fff", strokeWidth: 1.5, minZoom: 8 }
  ]
}).addTo(map);

points.setViewTransform({ rotation: 25, pitch: 35 });

const inspector = performanceInspector(map);
const snapshot = await inspector.measureFrames(30);

const prepared = preparePointBatch(rawPoints);
const cache = offlineTileCache({ cacheName: "city-tiles" });
await cache.prefetchTileLayer(streets, {
  bounds: map.getBounds(),
  zooms: [10, 11, 12]
});
const swScript = cache.createServiceWorkerScript({
  urlPrefixes: ["https://tile.openstreetmap.org/"]
});

defineOrihonElement();
```

## Browser And CDN Builds

`npm run build` emits:

- `dist/core.js`, `dist/standard.js`, `dist/index.js` and `.d.ts` for tree-shakeable modular ESM.
- `dist/orihon.core.esm.js`, `dist/orihon.standard.esm.js` and `dist/orihon.esm.js` as minified single-file ESM bundles.
- `dist/orihon.global.js`, a standalone IIFE that exposes `globalThis.Orihon` and resolved `globalThis.OrihonReady` without a runtime `import()`.
- `dist/orihon.css`.
- `dist/release-manifest.json` with raw and gzip artifact sizes.

For a script-tag/global setup:

```html
<link rel="stylesheet" href="./dist/orihon.css" />
<script src="./dist/orihon.global.js"></script>
<script>
  const map = Orihon.createMap("map", { center: [52.52, 13.405], zoom: 10 });
</script>
```

`npm run size` enforces gzip budgets in CI (current builds stay under them):

| Artifact | Budget |
| --- | --- |
| `orihon.core.esm.js` | ≤ 22 KiB gzip |
| `orihon.standard.esm.js` | ≤ 36 KiB gzip |
| `orihon.esm.js` | ≤ 141 KiB gzip (Advanced + WebGL/WebGPU/WASM) |
| `orihon.controls.esm.js` | ≤ 8 KiB gzip (imports shared modules) |
| `orihon.geo.esm.js` | ≤ 2 KiB gzip (imports shared geometry) |

Raw minified sizes are larger; production cost is the gzip figure. Prefer modular imports when you do not need the full surface.

## Documentation

- [API reference](docs/API.md)
- [Security model](docs/SECURITY.md)
- [Development, versions and benchmarks](docs/DEVELOPMENT.md)
- [License FAQ](docs/LICENSE-FAQ.md)
- [Enhancement roadmap](docs/ROADMAP.md)
- [Recipes](docs/RECIPES.md)
- [Plugin development](docs/PLUGINS.md)
- [Scale showcase](examples/showcase) (open `index.html` · [live](https://whahedev.github.io/orihon/showcase/))
- [Engine benchmark](examples/bench-compare) (open `index.html` · [live](https://whahedev.github.io/orihon/bench/))
- [European temperature heatmap and isolines](examples/temperature-isolines) — one million clickable GPU observations, heatmap/isolines modes, labels and point popups
- [Examples hub](https://whahedev.github.io/orihon/)

## Design Goals

- Keep Core / Standard / Advanced as explicit product tiers with gzip budgets on each entry.
- Make common GIS tasks easy without hiding browser primitives.
- Prefer fast DOM transforms and compact data structures over heavyweight render stacks.
- Let advanced services such as search, routing, traffic and proprietary tiles be plugged in through providers.

## License

Orihon is a free, open-source browser map engine licensed under the **Apache License 2.0**. Use it anywhere — personal projects, education, and commercial products included. No separate paid engine license.

Want to build visually? Try Orihon Studio (`npm run demo:studio`).

Copyright 2026 whahe.

See [LICENSE](./LICENSE), [LICENSE-NOTICE.md](./LICENSE-NOTICE.md) and the [License FAQ](docs/LICENSE-FAQ.md).
