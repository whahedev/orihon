# Orihon Easy API

`orihon/easy` is a beginner-oriented API adapter over the **Standard** package tier. It is not a fourth engine build and does not create a second map implementation. The returned value is the regular `Orihon` map, with a few instance-local convenience methods.

## One sentence language

Orihon keeps **two** public sentence subjects:

| Level | Subject | Canonical form |
| --- | --- | --- |
| **Easy** | the map | `map.addMarker({ position, appearance })` |
| **Standard (Layer API)** | the layer | `marker(position).addTo(map)` |

Easy is **object-first only**: every `addX` takes one options object (self-documenting fields + autocomplete). There is no positional `addMarker(latlng, options)`, no `addPolyline(points, style)`, and no declarative `map.add({ type })`.

```ts
import { createMap } from "orihon/easy";
import "orihon/orihon.css";

const map = createMap("map", {
  center: { lat: 55.751244, lng: 37.618423 },
  zoom: 12,
  basemap: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors"
  }
});

const office = map.addMarker({
  position: { lat: 55.751244, lng: 37.618423 },
  appearance: { shape: "pin", color: "#2563eb" },
  popup: "Office",
  draggable: true
});

map.addPolyline({
  points: [
    { lat: 55.75, lng: 37.61 },
    { lat: 55.76, lng: 37.63 }
  ],
  style: { stroke: "#2563eb", strokeWidth: 4 }
});
```

## Why this is separate from package tiers

Package complexity describes shipped capability and size:

- **Core** — map, camera, geometry and DOM raster tiles.
- **Standard** — Core plus markers, vectors, GeoJSON, overlays and controls.
- **Advanced** — Standard plus GPU rendering, large datasets and infrastructure.

API complexity describes how directly an application controls those capabilities:

- **Easy API** — common operations are expressed as map options and map methods.
- **Layer API** — applications compose `tileLayer()`, `marker()`, `geoJSON()` and other layers explicitly.
- **Rendering API** — applications select GPU backends, packed inputs, workers and renderer-specific diagnostics.

Easy therefore sits on top of Standard. It does not change the Core/Standard/Advanced gzip budgets.
String basemaps use the Standard DOM tile renderer by default. An explicit `renderer` option remains available when an application deliberately registers or imports an accelerated backend. A ready `Layer` is added unchanged, so WMS, WMTS and custom layer implementations can also be used as the basemap.

## Map options

`createMap(container, options)` accepts every regular `MapOptions` field plus `basemap`:

| Field | Type | Purpose |
| --- | --- | --- |
| `basemap` | `Layer \| TileTemplate \| EasyBasemapOptions \| false \| null` | Adds a ready layer or creates one raster tile layer and manages it as the basemap. |
| `basemap.url` | `TileTemplate` | URL template or tile URL function. |
| `basemap.attribution` | `string` | Data attribution displayed by the map. |
| remaining basemap fields | `TileLayerOptions` | The normal tile cache, zoom, bounds, opacity and request settings. |

## Map-centric methods

| Method | Options object | Returns |
| --- | --- | --- |
| `addMarker` | `{ position, appearance? \| content \| icon, popup?, … }` | `Marker` |
| `addPolyline` | `{ points, style?, popup?, … }` | `Polyline` |
| `addPolygon` | `{ rings, style?, popup?, … }` | `Polygon` |
| `addTileLayer` | `{ url, …TileLayerOptions }` | `RasterTileLayer` |
| `addGeoJSON` | `{ data?, …GeoJSONOptions }` | `GeoJSONLayer` |
| `setBasemap` / `getBasemap` | basemap config or ready `Layer` | map / layer |

Built-in marker visuals use nested `appearance` (`shape`, `color`, …). Flat `color` / `shape` on the Easy options object are rejected so autocomplete points at one place.

The returned objects are not Easy wrappers. They retain their complete layer API, events and removal lifecycle.

### Examples

```ts
const marker = map.addMarker({
  position: { lat: 52.52, lng: 13.405 },
  title: "Berlin",
  appearance: { shape: "pin", color: "#0f766e" },
  popup: "Berlin",
  tooltip: "Open details"
});

const route = map.addPolyline({
  points: [{ lat: 52.50, lng: 13.38 }, { lat: 52.54, lng: 13.43 }],
  style: { stroke: "#2563eb", strokeWidth: 3 }
});

const district = map.addPolygon({
  rings: area,
  style: { fill: "#2563eb", fillOpacity: 0.2 }
});

const places = map.addGeoJSON({
  data: featureCollection,
  pointToLayer: (feature, position) => marker(position)
});

const labels = map.addTileLayer({
  url: "https://example.test/{z}/{x}/{y}.png",
  opacity: 0.8
});
```

### Mixing with the Layer API

```ts
import { createMap } from "orihon/easy";
import { polygon } from "orihon/standard";

const map = createMap("map", { center: { lat: 52.52, lng: 13.405 }, zoom: 10 });

map.addMarker({ position: { lat: 52.52, lng: 13.405 } }); // Easy sentence
polygon(area).addTo(map);                                  // Layer sentence
```

## Why there is no `map.addSource()` yet

Orihon currently composes data providers directly into layers. A useful `addSource()` needs more than a renamed `addGeoJSON()`: it needs a named source registry, independent source update/removal, validation, and support for several layers consuming the same source. Pretending that a GeoJSON layer is a reusable source would lock applications into the wrong lifecycle. The method will be introduced only together with that real source abstraction; today use `addGeoJSON()` for GeoJSON data and `addTileLayer()` for raster tile sources.
