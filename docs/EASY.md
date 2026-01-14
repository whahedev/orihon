# Orihon Easy API

`orihon/easy` is a beginner-oriented API adapter over the **Standard** package tier. It is not a fourth engine build and does not create a second map implementation. The returned value is the regular `Orihon` map, with a few instance-local convenience methods.

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

map.addMarker({
  position: { lat: 55.751244, lng: 37.618423 },
  popup: "Москва"
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

The Easy map groups the most common creation operations under `map.add…`, so IDE autocomplete can act as a compact catalogue:

| Method | Creates and returns |
| --- | --- |
| `addMarker(options)` or `addMarker(position, options?)` | A normal interactive `Marker`; the object form can also bind a popup and tooltip. |
| `addTileLayer(template, options?)` | A normal Standard `TileLayer`. |
| `addPolyline(points, options?)` | A normal `Polyline`. |
| `addPolygon(rings, options?)` | A normal `Polygon`, including polygons with inner rings. |
| `addGeoJSON(data, options?)` | A normal `GeoJSONLayer`. |
| `add(layer)` | Adds any already-created `Layer`; this short alias is available on every Orihon map. |
| `addLayer(layer)` / `addControl(control)` | The existing explicit lifecycle methods remain available. |

The returned objects are not Easy wrappers. They retain their complete layer API, events and removal lifecycle.

## One declarative `map.add(description)`

Component frameworks and configuration-driven applications can express the same objects through one discriminated description. TypeScript narrows the valid fields from `type`, and `map.add()` returns the created normal Orihon layer.

```ts
const moscow = map.add({
  type: "marker",
  position: { lng: 37.6176, lat: 55.7558 },
  popup: "Москва"
});

const route = map.add({
  type: "polyline",
  coordinates: [
    { lng: 37.60, lat: 55.75 },
    { lng: 37.65, lat: 55.77 }
  ],
  style: {
    width: 4,
    opacity: 0.8,
    stroke: "#2563eb"
  }
});

const places = map.add({ type: "geojson", data });
const basemap = map.add({ type: "raster", url });
```

Supported descriptions:

| `type` | Required data | Options | Result |
| --- | --- | --- | --- |
| `marker` | `position` | Normal marker fields plus `popup`, `popupOptions`, `tooltip`, `tooltipOptions` | `Marker` |
| `polyline` | `coordinates` | `style`, popup and tooltip fields | `Polyline` |
| `polygon` | `coordinates` (one ring or rings with holes) | `style`, popup and tooltip fields | `Polygon` |
| `geojson` | `data` (`GeoJSONData` or `FeatureSource`) | `options: GeoJSONOptions` | `GeoJSONLayer` |
| `raster` | `url` | `options: TileLayerOptions` | `TileLayer` |

Polyline and polygon styles use the normal `stroke`, `strokeWidth`, `strokeOpacity`, `fill` and `fillOpacity` vocabulary. Inside Easy descriptions, `width` and `opacity` are concise aliases for `strokeWidth` and `strokeOpacity`; canonical fields win if both forms are supplied.

This shape maps directly to a component prop or reactive configuration object. Framework integrations only need to retain the returned layer and call `remove()` when the component unmounts; they do not need a second renderer or a framework-specific map implementation.

### `map.addMarker(options)`

Creates a normal `Marker`, optionally binds its popup and tooltip, adds it to the map and returns it. The returned marker still supports the complete Layer API.

```ts
const marker = map.addMarker({
  position: { lat: 52.52, lng: 13.405 },
  title: "Berlin",
  color: "#0f766e",
  popup: "Berlin",
  tooltip: "Open details"
});

marker.setOpacity(0.8).bindPopup("Updated content");
```

### `map.addTileLayer()`, `map.addPolyline()`, `map.addPolygon()` and `map.addGeoJSON()`

Each method combines a regular Standard factory with `addTo(map)` and returns the created layer:

```ts
const route = map.addPolyline(
  [[52.50, 13.38], [52.54, 13.43]],
  { stroke: "#2563eb", strokeWidth: 3 }
);

const district = map.addPolygon(area, {
  fill: "#2563eb",
  fillOpacity: 0.2
});

const places = map.addGeoJSON(featureCollection, {
  pointToLayer: (feature, position) => marker(position)
});

// A shared reactive source from `orihon/source` is accepted too.
const livePlaces = map.addGeoJSON(placeSource);

const labels = map.addTileLayer("https://example.test/{z}/{x}/{y}.png", {
  opacity: 0.8
});
```

### `map.add(layer)`

Use `add()` when a layer already exists or comes from another function. It returns the map, like `addLayer()`, so both composition styles remain equivalent:

```ts
const place = marker([52.52, 13.405]);

map.add(place);                    // map-centric
marker([52.52, 13.405]).addTo(map); // object-centric
```

The overload is intentional: `map.add(existingLayer)` returns the map, preserving the normal layer lifecycle; `map.add(description)` returns the newly created layer so an application can subscribe to it, update it or remove it later.

### `map.setBasemap(basemap)`

Replaces only the basemap owned by the Easy adapter. Other layers are not removed. Pass `false` or `null` to remove it.

A ready Standard or custom layer is accepted unchanged. This keeps provider-specific methods available on the original object:

```ts
import { createMap } from "orihon/easy";
import { wmtsTileLayer } from "orihon/standard";

const basemap = wmtsTileLayer(url, {
  layer: "basemap",
  tileMatrixSet: "EPSG:3857"
});

const map = createMap("map", {
  center: { lat: 55.751244, lng: 37.618423 },
  zoom: 12,
  basemap
});

map.getBasemap() === basemap; // true
```

### `map.getBasemap()`

Returns the active Easy basemap as the original `Layer`, or `null`. URL/template basemaps return the `TileLayer` created by Easy.

## Moving between API levels

Easy and Layer API can be mixed because they use the same objects:

```ts
import { createMap } from "orihon/easy";
import { polygon } from "orihon/standard";

const map = createMap("map", { center: [52.52, 13.405], zoom: 10 });

map.addMarker({ position: [52.52, 13.405] });
map.add(polygon(area));
```

Applications can migrate to explicit layers gradually; there is no separate Easy runtime to replace.

## Why there is no `map.addSource()` yet

Orihon currently composes data providers directly into layers. A useful `addSource()` needs more than a renamed `addGeoJSON()`: it needs a named source registry, independent source update/removal, validation, and support for several layers consuming the same source. Pretending that a GeoJSON layer is a reusable source would lock applications into the wrong lifecycle. The method will be introduced only together with that real source abstraction; today use `addGeoJSON()` for GeoJSON data and `addTileLayer()` for raster tile sources.
