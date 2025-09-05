# Orihon

[![npm](https://img.shields.io/npm/v/orihon?color=0f766e)](https://www.npmjs.com/package/orihon)
[![downloads](https://img.shields.io/npm/dm/orihon?color=0f766e)](https://www.npmjs.com/package/orihon)
[![CI](https://github.com/whahedev/orihon/actions/workflows/ci.yml/badge.svg)](https://github.com/whahedev/orihon/actions/workflows/ci.yml)
[![full size](https://img.shields.io/badge/full-≤70_KiB_gzip-0f766e)](https://github.com/whahedev/orihon#tiers)
[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial-555)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178c6)](./tsconfig.json)

## Unfold the world.

Orihon is a lightweight, high-performance mapping library built around a simple idea:

**less weight, more space.**

Inspired by the Japanese folding book, Orihon treats the map as a continuous surface — compact in form, boundless when unfolded.

Layers appear.  
Geometry moves.  
Surfaces connect.  
The world keeps unfolding.

At just **70 KB gzipped**, Orihon stays small where it matters — without sacrificing speed or capability.

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

Orihon is licensed under the PolyForm Noncommercial License 1.0.0. Non-commercial use is free; commercial use requires a separate license. See [License](#license).

## Tiers

Orihon is built as three intentional surfaces. Start narrow; grow only when the product needs it.

| Tier | Import | What you get |
| --- | --- | --- |
| **Core** | `orihon/core` | Map, events, geometry, DOM tiles, grid |
| **Standard** | `orihon/standard` | Core + markers, SVG/canvas vectors, GeoJSON (`svg`/`canvas`), popups, controls, overlays, locales — **no WebGL** |
| **Advanced** | `orihon` | Standard + WebGL (points, heat, path batch, raster tiles), MVT, ObjectManager, routing, traffic, offline, workers, adapters |

**WebGL policy:** Core/Standard stay CPU/DOM. Advanced opts into GPU only where dataset size or continuous camera stress pays for it (`webglPointLayer`, `webglHeatLayer`, `webglTileLayer`, `geoJSON({ renderer: "webgl" })` / `auto` on large path sets).

```js
// Core — basemap only
import { createMap, tileLayer } from "orihon/core";

// Standard — everyday GIS UI (SVG/canvas GeoJSON)
import { createMap, tileLayer, marker, geoJSON, zoomControl } from "orihon/standard";

// Advanced — GPU when volume / camera stress needs it
import { createMap, objectManager, webglPointLayer, geoJSON } from "orihon";
```

Gzip budgets stay attached to the tiers: core ≤ 22 KiB, standard ≤ 35 KiB, full (Advanced + WebGL) ≤ 70 KiB. Prefer the smallest entry that covers the feature set.

**ObjectManager** is the Advanced-tier answer to heavy datasets: render and manage 100,000+ map objects without keeping 100,000 DOM markers alive.

## Quick Start

```js
import { createMap, tileLayer, marker, polyline } from "orihon";
import "orihon/orihon.css";

const map = createMap("map", {
  center: [52.520008, 13.404954],
  zoom: 10
});

tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "\u00a9 OpenStreetMap contributors"
}).addTo(map);

marker([52.520008, 13.404954], { title: "Berlin" }).addTo(map);

polyline([
  [52.51, 13.37],
  [52.53, 13.41],
  [52.50, 13.44]
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
- `MarkerCollection` — viewport-culled DOM or auto WebGL for large point sets (50k+).
- GeoJSON with `filter`, `style`, `pointToLayer`, `onEachFeature`.
- Popups and tooltips (`bindPopup`, `bindTooltip`, auto-pan).
- Image / video / SVG overlays, WMS tiles, canvas base layer, `LayerGroup` / `FeatureGroup`.
- Zoom, scale, attribution, geolocation, layers and custom controls with locales (`en`, `ru`, `ar`, `tr`, `zh`, `de`, `fr`, `da`, `hi`).

### Advanced

Everything in Standard, plus:

- `ObjectManager` / `RemoteObjectManager` — high-volume collections with viewport DOM, clustering and stale-request cancellation.
- `WebGLPointLayer`, `WebGLHeatLayer`, `HeatIsolineLayer` / `buildHeatIsolines`, MVT-capable `VectorTileLayer`, canvas `heatLayer`.
- Provider-based search, suggest, routing and traffic.
- Offline tile cache / Service Worker helpers, geometry workers, performance inspector and framework / Web Component adapters.

Runtime profile across tiers: reusable DOM panes, tile cache limits, SVG path reuse, spatial grid queries and differential marker rendering.

## TypeScript

The source is strict TypeScript. `npm run build` writes ESM modules, source maps and generated declarations to `dist`.

Use named imports:

```js
import { createMap, tileLayer, marker, featureGroup, circle, rectangle, layersControl } from "orihon";
import "orihon/orihon.css";

const map = createMap("map", { center: [52.52, 13.405], zoom: 10 });
const streets = tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
const places = featureGroup([
  marker([52.52, 13.405]).bindPopup("Berlin"),
  circle([52.54, 13.43], 750),
  rectangle([[52.49, 13.35], [52.54, 13.45]])
]).addTo(map);

map.fitBounds(places.getBounds());
layersControl({ Streets: streets }, { Places: places }).addTo(map);
```

## ObjectManager

Render and manage 100,000+ map objects without keeping 100,000 DOM markers alive.

```js
import { createMap, objectManager, tileLayer } from "orihon";
import "orihon/orihon.css";

const map = createMap("map", { center: [55.75, 37.62], zoom: 11 });
tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

const manager = objectManager({
  cluster: true,
  clusterRadius: 60
}).addTo(map);

manager.add(
  Array.from({ length: 50_000 }, (_, id) => ({
    type: "Feature",
    id,
    geometry: {
      type: "Point",
      coordinates: [37.4 + Math.random() * 0.5, 55.6 + Math.random() * 0.3]
    },
    properties: { name: `Point ${id}` }
  }))
);
```

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

Grid and media overlays expose the same lightweight lifecycle surface:

```js
gridLayer({ tileSize: 512 });
videoOverlay("traffic.mp4", [[52.48, 13.30], [52.55, 13.45]], { poster: "preview.png" }).addTo(map);
svgOverlay(document.querySelector("svg"), [[52.48, 13.30], [52.55, 13.45]]).addTo(map);
```

## Rich Popup Content

Every interactive layer accepts text, numbers, DOM nodes, async factories or mountable component objects. Mountable content is useful for charts and framework roots because Orihon calls its cleanup when the popup closes:

```js
marker([52.52, 13.405])
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
  center: [52.52, 13.405],
  zoom: 10,
  locale: "de",
  ariaLabel: "Objektkarte"
});

scaleControl({ units: "both" }).addTo(map);
customControl((currentMap) => `z${currentMap.getZoom()}`, {
  position: "bottom-left",
  ariaLabel: "Aktueller Zoom"
}).addTo(map);

const place = marker([52.52, 13.405], { opacity: 0.8, zIndexOffset: 100 })
  .bindPopup("Objekt", { autoPan: true, keepInView: true })
  .addTo(map);
```

## Services And Behaviors

The services layer stays provider-based: Orihon owns orchestration, cancellation and display, while an app can plug in local or commercial data providers.

```js
const search = createArraySearchProvider([
  { name: "Berlin", center: [52.520, 13.405] },
  { name: "Hamburg", center: [53.551, 9.994] }
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

await routes.route([[52.52, 13.40], [52.55, 13.45]]);
routes.select(1);

const traffic = trafficLayer("/traffic/{z}/{x}/{y}.png").addTo(map);
traffic.on("statechange", ({ state }) => console.log(state));
traffic.refresh();

map.behaviors.disable("scrollZoom");
map.behaviors.enable("dblClick");
```

## Advanced Modules

Orihon 1.0 keeps advanced modules opt-in for large datasets and production diagnostics without making the everyday map heavier.

Public stress demo: [`examples/webgl-points-demo`](examples/webgl-points-demo) — switch **100k / 500k / 1M** points and live-read FPS, frame time, memory, visible and rendered counts through `performanceInspector` (`npm run demo:webgl`).

Comparative engine bench: [`examples/bench-compare`](examples/bench-compare) — same point workload across Orihon, Leaflet, OpenLayers and MapLibre (`npm run demo:bench`).

```js
const points = webglPointLayer(bigPointArray, {
  pointSize: 4,
  color: "#e11d48"
}).addTo(map);

const vectorTiles = vectorTileLayer({
  provider: async ({ x, y, z, signal }) => {
    const response = await fetch(`/tiles/${z}/${x}/${y}.json`, { signal });
    return response.json();
  },
  style: (feature) => ({ stroke: feature.properties.color })
}).addTo(map);

const mvtProvider = createMVTProvider("/mvt/{z}/{x}/{y}.pbf", { layer: "roads" });
vectorTileLayer({ provider: mvtProvider }).addTo(map);

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
| `orihon.standard.esm.js` | ≤ 35 KiB gzip |
| `orihon.esm.js` | ≤ 70 KiB gzip (Advanced + WebGL) |

Raw minified sizes are larger; production cost is the gzip figure. Prefer modular imports when you do not need the full surface.

## Documentation

- [API reference](docs/API.md)
- [Security model](docs/SECURITY.md)
- [Pricing](docs/PRICING.md)
- [License FAQ](docs/LICENSE-FAQ.md)
- [Commercial License Agreement](docs/COMMERCIAL-LICENSE.md)
- [Library comparison](docs/COMPARE.md)
- [Recipes](docs/RECIPES.md)
- [Plugin development](docs/PLUGINS.md)
- [WebGL points demo](examples/webgl-points-demo) (`npm run demo:webgl`)
- [Engine benchmark](examples/bench-compare) (`npm run demo:bench`)

## Design Goals

- Keep Core / Standard / Advanced as explicit product tiers with gzip budgets on each entry.
- Make common GIS tasks easy without hiding browser primitives.
- Prefer fast DOM transforms and compact data structures over heavyweight render stacks.
- Let advanced services such as search, routing, traffic and proprietary tiles be plugged in through providers.

## License

Orihon is source-available software licensed under the **PolyForm Noncommercial License 1.0.0**.

### Community — free

Non-commercial use is free under PolyForm Noncommercial, including personal projects, education, research, evaluation, proofs of concept and development before commercial launch. Install from npm and build without talking to sales.

### Commercial — yearly license per legal entity

**Commercial production requires a commercial license.** Pricing is by organization revenue band, not by seat or map view:

| Plan | Price |
| --- | --- |
| Indie | $149 / year (own products · ≤ $100k revenue) |
| Startup | $499 / year (own products · ≤ $1M) · most popular |
| Business | $1,499 / year (own products · ≤ $20M) |
| Agency | $799 / year (**required** for client / third-party work) |
| Enterprise | from $5,000 / year |

Paid plans: **unlimited developers, applications, domains and map views.** Same npm package for everyone — no feature gating, no runtime license keys. Annual renewal buys updates and new-project rights; Eligible Versions already in production keep perpetual run rights (see [Commercial License Agreement](docs/COMMERCIAL-LICENSE.md)).

Full detail: [Pricing](docs/PRICING.md), [License FAQ](docs/LICENSE-FAQ.md) and the [Commercial License Agreement](docs/COMMERCIAL-LICENSE.md) (v1.0).

### In short

**Free for personal, educational and non-commercial use (including evaluation). Commercial production needs a company license — not per-seat, not per-view.**

Orihon is source-available, but it is not OSI-approved open-source software because commercial use is restricted.

Copyright © 2026 whahe.

See [LICENSE](./LICENSE) and [LICENSE-NOTICE.md](./LICENSE-NOTICE.md).
