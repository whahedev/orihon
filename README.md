<p align="center">
  <img src="./assets/brand/svg/orihon-logo-horizontal.svg" alt="Orihon — folded map and route logo" width="520" />
</p>

# Orihon

**A fast, typed browser map engine with a small path from first map to large-scale GIS.**

[![npm](https://img.shields.io/npm/v/orihon?color=0f766e)](https://www.npmjs.com/package/orihon)
[![downloads](https://img.shields.io/npm/dm/orihon?color=0f766e)](https://www.npmjs.com/package/orihon)
[![CI](https://github.com/whahedev/orihon/actions/workflows/ci.yml/badge.svg)](https://github.com/whahedev/orihon/actions/workflows/ci.yml)
[![full size](https://img.shields.io/badge/full-<150_KiB_gzip-0f766e)](#size)
[![license](https://img.shields.io/badge/license-Apache%202.0-0f766e)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178c6)](./tsconfig.json)

Orihon is a free, open-source browser mapping library. Start with a map-centric API for common work, move to explicit layers when you need more control, and opt into GPU rendering and large-data tools only when the application needs them.

Apache 2.0. No engine key. No paid runtime license.

## Start here

Starting from an empty folder? One command writes a project that already draws a map:

```sh
npm create orihon-app my-map
cd my-map
npm install
npm run dev
```

Templates are `vanilla` and `react`, both on Vite; `npm create orihon-app my-map -- --template react --yes` skips the prompts. The generated project already contains the stylesheet import, a container with a height, an attribution and one working map, so the first thing you see is a map rather than a setup checklist.

Already have a Vite, React, Vue or other ESM application?

```sh
npm install orihon
```

Then create a map with `orihon/easy`:

```js
import { createMap } from "orihon/easy";
import "orihon/orihon.css";

const map = createMap("map", {
  center: { lat: 52.52, lng: 13.405 },
  zoom: 12,
  basemap: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors"
  }
});

map.addMarker({
  position: { lat: 52.52, lng: 13.405 },
  appearance: { shape: "pin", color: "#2563eb" },
  popup: "Berlin"
});
```

Your page needs a container with a real size:

```html
<div id="map"></div>

<style>
  html,
  body {
    margin: 0;
    height: 100%;
  }

  #map {
    height: 100vh;
    min-height: 360px;
  }
</style>
```

That is enough for a pannable, zoomable OpenStreetMap basemap with a marker and popup.

A `<div>` has no height of its own, which is the most common reason a first map looks broken: tiles are requested, layers exist, nothing is painted. Orihon says so in the console instead of leaving you to guess — see [Troubleshooting](./docs/TROUBLESHOOTING.md#zero-size-container).

## Add common map objects

The Easy API is map-centric and object-first. Each operation takes one options object, so the fields are visible in autocomplete and there are no positional Easy overloads to memorize.

```js
map.addPolyline({
  points: [
    { lat: 52.51, lng: 13.37 },
    { lat: 52.53, lng: 13.41 },
    { lat: 52.50, lng: 13.44 }
  ],
  style: {
    stroke: "#2563eb",
    strokeWidth: 4
  }
});

map.addPolygon({
  rings: [
    { lat: 52.50, lng: 13.38 },
    { lat: 52.54, lng: 13.39 },
    { lat: 52.53, lng: 13.45 },
    { lat: 52.50, lng: 13.38 }
  ],
  style: {
    fill: "#2563eb",
    fillOpacity: 0.2,
    stroke: "#2563eb"
  },
  popup: "District"
});

const places = map.addGeoJSON({
  data: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Alexanderplatz" },
        geometry: {
          type: "Point",
          coordinates: [13.4132, 52.5219]
        }
      }
    ]
  }
});

map.fitBounds(places.getBounds());
```

Easy currently covers the common first-map operations:

- `addMarker({ position, ... })`
- `addPolyline({ points, ... })`
- `addPolygon({ rings, ... })`
- `addGeoJSON({ data, ... })`
- `addTileLayer({ url, ... })`
- `setBasemap(...)` / `getBasemap()`

The objects returned by those methods are normal Orihon layers, not wrappers. You can use their events, popup APIs, setters and normal `remove()` lifecycle immediately.

See the [Easy API guide](./docs/EASY.md) for the complete contract.

## When you need more control

You do not need to choose the whole architecture before drawing the first map.

Start with `orihon/easy`. Move to the Layer API only where the application needs explicit composition:

```js
import { polygon } from "orihon/standard";

const area = polygon(
  [
    { lat: 52.50, lng: 13.38 },
    { lat: 52.54, lng: 13.39 },
    { lat: 52.53, lng: 13.45 },
    { lat: 52.50, lng: 13.38 }
  ],
  {
    fill: "#0f766e",
    fillOpacity: 0.2,
    stroke: "#0f766e"
  }
).addTo(map);

area.bindPopup("Custom layer");
```

The two public sentence forms are intentional:

| API | Sentence | Use it for |
| --- | --- | --- |
| **Easy** | `map.addMarker({ ... })` | First maps and common application work |
| **Layer API** | `marker(position).addTo(map)` | Explicit composition and the full layer surface |

There is no third generic `map.add({ type, ... })` dialect.

## Coordinates without guessing

Application-facing geographic coordinates use named values:

```js
const berlin = { lat: 52.52, lng: 13.405 };
```

When converting from another convention, make the order explicit:

```js
import {
  latLng,
  lngLat,
  fromGeoJSONPosition,
  toGeoJSONPosition
} from "orihon/standard";

const moscow = latLng(55.751244, 37.618423); // latitude, longitude
const berlin = lngLat(13.405, 52.52);        // longitude, latitude

const point = fromGeoJSONPosition([13.405, 52.52]);
const geojsonPosition = toGeoJSONPosition(point); // [13.405, 52.52]
```

A list names its order once instead of repeating `lat` and `lng` on every point:

```js
import { latLngs, lngLats, fromGeoJSONPositions, polyline } from "orihon/standard";

polyline(latLngs([[52.51, 13.37], [52.53, 13.41], [52.50, 13.44]]));
polyline(lngLats(maplibreCoordinates));
polyline(fromGeoJSONPositions(feature.geometry.coordinates));
```

`latLngs()` and `lngLats()` also read a flat run of numbers — `latLngs([52.51, 13.37, 52.53, 13.41])`, or a `Float64Array` straight from a worker, which skips building one pair object per point. An odd length throws instead of shifting every later point by one place.

GeoJSON keeps the standard `[longitude, latitude]` order. Normal Orihon geographic APIs prefer `{ lat, lng }` so a bare numeric tuple cannot silently swap the two.

## Choose a package tier later

Package size and API difficulty are separate concerns. The Easy API is a beginner-oriented adapter over Standard; Core, Standard and Advanced describe capability and bundle size.

| Tier | Import | What it includes |
| --- | --- | --- |
| **Core** | `orihon/core` | Map, camera, events, geometry, DOM raster tiles and grid primitives |
| **Standard** | `orihon/standard` | Core + markers, SVG/canvas vectors, GeoJSON, popups, overlays, controls and locales |
| **Advanced** | `orihon` | Standard + WebGL/WebGPU, MVT, heat, ObjectManager, workers, routing, traffic and offline tooling |

A normal application can stay on Standard indefinitely. Importing the Advanced root is for cases where dataset size, rendering load or infrastructure features justify it.

GPU rendering is explicit:

```js
import { tileLayer } from "orihon";

tileLayer("/tiles/{z}/{x}/{y}.png");
// DOM renderer — stable default.

tileLayer("/tiles/{z}/{x}/{y}.png", { renderer: "auto" });
// Prefer WebGPU, then WebGL, then DOM.

tileLayer("/tiles/{z}/{x}/{y}.png", { renderer: "webgl" });
// WebGL is required; unsupported capability throws instead of silently changing renderer.
```

Optional product-specific entry points stay separate from those tiers:

- `orihon/easy` — map-centric first-map API
- `orihon/source` — reactive `FeatureSource`
- `orihon/react` — React bindings
- `orihon/draw` — drawing and editing
- `orihon/controls` — fullscreen, measure, minimap and graticule
- `orihon/geo` — additional geographic helpers
- `orihon/popup-content` — declarative rich popup content
- `orihon/pmtiles`, `orihon/mvt`, `orihon/mlt`, `orihon/mvt-wasm` — packed tile formats
- `orihon/webgpu` — explicit WebGPU integration

## Common next steps

### Reactive data

If the same data should drive several renderers, use `FeatureSource` instead of rebuilding application state around a particular layer:

```js
import { featureSource } from "orihon/source";
import { geoJSON } from "orihon/standard";

const source = featureSource();
const layer = geoJSON(source).addTo(map);

source.add({
  type: "Feature",
  id: "station-1",
  properties: { name: "Central Station" },
  geometry: {
    type: "Point",
    coordinates: [13.3694, 52.5251]
  }
});
```

One source can feed GeoJSON, labels and high-volume rendering. See [FeatureSource](./docs/FEATURE_SOURCE.md).

### Large datasets

The Advanced entry includes `ObjectManager`, GPU point/path rendering, heatmaps, vector tiles, workers and performance diagnostics. `ObjectManager` is intended for tens of thousands to millions of application objects without one DOM marker per object.

For large cooperative imports:

```js
import { objectManager } from "orihon";

const manager = objectManager({
  clusterize: true,
  clusterRenderer: "auto",
  layoutWorker: "auto"
}).addTo(map);

await manager.addAsync(objects, {
  chunkSize: 10_000,
  yieldMode: "task",
  signal: abortController.signal
});
```

The detailed data, styling, clustering, heatmap and lifecycle contracts live in the [API reference](./docs/API.md) instead of this README.

### React

React bindings are published from `orihon/react` and use the same map/layer concepts. React and React DOM are optional peer dependencies, so non-React applications do not pull them in.

See the [API reference](./docs/API.md) and the runnable example under [`examples/react`](./examples/react).

### Drawing and controls

Drawing/editing is opt-in through `orihon/draw`. Additional UI such as fullscreen, measurement, minimap and graticule lives under `orihon/controls`.

Keeping these entry points separate means a normal map does not pay for product-specific UI it never uses.

## TypeScript and API contracts

Orihon is written in strict TypeScript and publishes generated declarations for every public entry point.

The public API follows a small set of rules:

- options objects are preferred when several independent values would otherwise become positional arguments;
- geographic units are visible in names such as `durationMs`, `radiusMeters` and `radiusPixels`;
- `addTo(map)` attaches reusable layers and controls; `remove()` detaches them;
- resource-owning services use terminal, idempotent `destroy()`;
- cancellation uses `AbortSignal` / `AbortError`;
- calls made after terminal destruction use `DestroyedError` rather than pretending the operation was cancelled;
- live map state is read-only from the public surface and changes through explicit methods;
- built-in events are typed by event name and payload.

The complete conventions are documented in [API-DESIGN.md](./docs/API-DESIGN.md).

## Performance

Orihon keeps rendering cost proportional to the job instead of forcing every application through the heaviest pipeline.

Core and Standard stay CPU/DOM. Advanced adds GPU backends for the workloads where they pay off: large point sets, heat, GPU raster tiles and large vector paths.

The repository includes two reproducible browser demos:

- [Scale showcase](./examples/showcase) — Core → Standard → Advanced, then large-data scenes ([live](https://whahedev.github.io/orihon/showcase/))
- [Engine benchmark](./examples/bench-compare) — the same point workload through Orihon, Leaflet, OpenLayers and MapLibre ([live](https://whahedev.github.io/orihon/bench/))

Run the benchmarks rather than relying on a headline number; browser, GPU, dataset shape and interaction pattern all matter.

## Size

Nothing Orihon ships crosses **150 KiB gzip**. `npm run size` fails the build when a published artifact exceeds its budget and checks this table against `dist/release-manifest.json`.

| Artifact | Budget | What it carries |
| --- | ---: | --- |
| `orihon.geo.esm.js` | ≤ 2 KiB gzip | Geometry helpers only |
| `orihon.popup-content.esm.js` | ≤ 5 KiB gzip | Popup content blocks |
| `orihon.controls.esm.js` | ≤ 8 KiB gzip | Optional controls |
| `orihon.draw.esm.js` | ≤ 12 KiB gzip | Draw/edit tools |
| `orihon.core.esm.js` | ≤ 18 KiB gzip | Map, events, geometry, DOM tiles |
| `orihon.standard.esm.js` | ≤ 38 KiB gzip | Everyday GIS, no WebGL |
| `orihon.esm.js` | ≤ 132 KiB gzip | Advanced: Standard + GPU, MVT, ObjectManager and WASM |
| `orihon.react.esm.js` | ≤ 118 KiB gzip | React bindings over the Advanced surface |
| `orihon.global.js` | ≤ 149 KiB gzip | Standalone script-tag build |

Prefer the smallest entry point that contains the capability you need. Exact raw and gzip sizes for the current build are written to `dist/release-manifest.json`.

## Browser builds

`npm run build` emits modular ESM, generated TypeScript declarations, minified single-file ESM bundles, CSS and a standalone `globalThis.Orihon` build.

Main artifacts include:

- `dist/core.js`
- `dist/standard.js`
- `dist/index.js`
- `dist/orihon.core.esm.js`
- `dist/orihon.standard.esm.js`
- `dist/orihon.esm.js`
- `dist/orihon.global.js`
- `dist/orihon.css`

If you self-host the standalone files, a script-tag page can use:

```html
<link rel="stylesheet" href="/vendor/orihon/orihon.css" />
<script src="/vendor/orihon/orihon.global.js"></script>
<script>
  const map = Orihon.createMap("map", {
    center: { lat: 52.52, lng: 13.405 },
    zoom: 12
  });
</script>
```

The global build exposes `globalThis.Orihon` and `globalThis.OrihonReady`.

## Documentation

Start with the guide that matches what you are doing:

- [Easy API](./docs/EASY.md) — first maps and map-centric methods
- [API reference](./docs/API.md) — complete public surface
- [Project starter](./packages/create-orihon-app) — what `npm create orihon-app` writes
- [Recipes](./docs/RECIPES.md) — task-oriented examples
- [FeatureSource](./docs/FEATURE_SOURCE.md) — shared reactive data
- [Troubleshooting](./docs/TROUBLESHOOTING.md) — blank maps, missing tiles, renderer errors
- [Migrating from Leaflet](./docs/MIGRATION-LEAFLET.md)
- [Migrating to the next major](./docs/MIGRATION-NEXT-MAJOR.md)
- [Security model](./docs/SECURITY.md)
- [Developer Guide](./examples/developer-guide) — generated searchable function catalogue with runnable examples
- [Examples hub](https://whahedev.github.io/orihon/)
- [Plugin development](./docs/PLUGINS.md)
- [Development, versions and benchmarks](./docs/DEVELOPMENT.md)
- [Pricing](./docs/PRICING.md) — what is free and what Studio adds
- [Enhancement roadmap](./docs/ROADMAP.md)

## Development

Repository development and release tooling requires **Node.js 22 or newer**. `.node-version` pins the tested LTS version.

```sh
npm install
npm run build
npm run check
```

Useful commands:

```sh
npm run typecheck
npm test
npm run test:browser
npm run test:e2e
npm run size
npm run docs:build
npm run docs:check
npm run demo:docs
npm run demo:showcase
npm run demo:bench
```

`npm run check` runs the type checks, unit tests, size budgets and documentation consistency checks used before publishing.

## Design goals

- Make the first map require very little API knowledge.
- Keep one predictable grammar inside each API level.
- Make coordinates, units, ownership and lifecycle explicit.
- Keep Core, Standard and Advanced as capability tiers with enforced size budgets.
- Let applications move from DOM/SVG/canvas to GPU rendering without replacing their map model.
- Keep I/O-heavy services provider-based so applications can supply local, commercial or test implementations.
- Prefer browser primitives and small data structures over mandatory heavyweight runtime stacks.

## Brand assets

Production-ready SVG/PNG logos, favicons and design tokens are published under [`orihon/brand/*`](./docs/BRAND.md).

## License

Orihon is licensed under the **Apache License 2.0**. Use it in personal, educational and commercial projects without a separate paid engine license.

See [LICENSE](./LICENSE), [LICENSE-NOTICE.md](./LICENSE-NOTICE.md) and the [License FAQ](./docs/LICENSE-FAQ.md).

Copyright 2026 whahe.
