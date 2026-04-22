# Migrating from Leaflet

Orihon's layer grammar is deliberately Leaflet-shaped: `factory(...).addTo(map)`, `remove()`,
`on()/off()`, `bindPopup()`. Most of a Leaflet application translates line for line.

Three things do not, and they are the ones worth reading before you start:

1. **Coordinates are named.** `[lat, lng]` is not accepted anywhere. This is the change that
   touches the most lines, and the one that removes a whole class of silent bugs.
2. **`L.` is gone.** Every factory is a named import, so bundlers can drop what you do not use.
3. **Some options are named rather than boolean**, where the option chose an implementation.

Nothing here is a compatibility shim: the names below are the real API, not aliases.

## Coordinates

This is the only mechanical rewrite that cannot be automated safely, because the same
`[a, b]` shape means two different things in a Leaflet codebase.

| Leaflet | Orihon | Why |
| --- | --- | --- |
| `[55.75, 37.62]` (map coordinate) | `{ lat: 55.75, lng: 37.62 }` | Latitude-first tuples read identically to GeoJSON positions, which are longitude-first |
| `L.latLng(55.75, 37.62)` | `latLng(55.75, 37.62)` | Same order |
| — | `lngLat(37.62, 55.75)` | For data that is already longitude-first |
| `L.latLngBounds(a, b)` | `bounds(a, b)` | Also accepts `{ south, west, north, east }` |
| `L.point(x, y)` | `point(x, y)` | Screen pixels keep tuples: `[x, y]` is unambiguous |
| `geometry.coordinates` in GeoJSON | **unchanged** | GeoJSON stays longitude-first; do not rewrite it |

```js
// Leaflet
L.marker([55.7558, 37.6176]).addTo(map);

// Orihon
marker({ lat: 55.7558, lng: 37.6176 }).addTo(map);
```

If a value came out of GeoJSON, convert it rather than reordering it by hand:

```js
import { fromGeoJSONPosition, toGeoJSONPosition } from "orihon/standard";

const position = fromGeoJSONPosition(feature.geometry.coordinates); // [lng, lat] -> LatLng
const exported = toGeoJSONPosition(marker.getLatLng());             // LatLng -> [lng, lat]
```

`LatLng` is a frozen value: read `latlng.lat` / `latlng.lng`, and build a changed coordinate
with `new LatLng(...)` or `clone()` rather than assigning through one. There is no `toArray()`,
because its result would be an ambiguous pair no Orihon API accepts back.

## Map

| Leaflet | Orihon |
| --- | --- |
| `L.map("id", options)` | `createMap("id", options)` |
| `map.setView(center, zoom)` | `map.setView(center, zoom)` |
| `map.setView(c, z)` in an animation loop | `map.updateView(c, z)` — keeps the gesture open, no `moveend` per step |
| `map.panTo`, `map.panBy`, `map.setZoom`, `map.zoomIn/Out`, `map.fitBounds`, `map.flyTo` | same names |
| `map.fitBounds(b, { animate: true })` | `map.fitBounds(b, { animation: "fly" })` |
| `map.addLayer`, `removeLayer`, `hasLayer`, `eachLayer` | same names |
| `map.remove()` | `map.remove()` or `map.destroy()` — both terminal |
| `map.getCenter/getZoom/getBounds/getSize` | same names |
| `map.invalidateSize()` | same name |
| `map.options.minZoom = 5` | `map.setMinZoom(5)` — `options` is a read-only view |
| `map.locate()` | `geolocationControl()` from `orihon/standard` |

`map.destroy()` is terminal: afterwards `addLayer`, `addControl` and `createPane` throw
`DestroyedError`, while camera calls are inert. Leaflet leaves this undefined.

## Layers

| Leaflet | Orihon |
| --- | --- |
| `L.tileLayer(url, o)` | `tileLayer(url, o)` |
| `L.tileLayer.wms(url, o)` | `wmsTileLayer(url, o)` |
| `L.marker(pos, o)` | `marker(pos, o)` |
| `L.polyline`, `L.polygon`, `L.rectangle`, `L.circle`, `L.circleMarker` | same names, unprefixed |
| `L.geoJSON(data, o)` | `geoJSON(data, o)` |
| `L.featureGroup(layers)` | `featureGroup(layers)` |
| `L.layerGroup(layers)` | `new LayerGroup(layers)` — no lowercase factory |
| `L.imageOverlay`, `L.videoOverlay`, `L.svgOverlay` | same names, unprefixed |
| `L.icon(o)` / `L.divIcon(o)` | `icon(o)` — `iconUrl` builds an `Icon`, `content` builds a `DivIcon` |
| `layer.addTo(map)` / `layer.remove()` | same |
| `layer.bindPopup` / `bindTooltip` / `openPopup` / `closePopup` | same, on `InteractiveLayer` |

Raster tile layers (`TileLayer`, WMS, WMTS, `GPUTileLayer`) do **not** have `bindPopup`: they
have no geographic anchor of their own. Use `map.on("click", ...)`.

## Controls

| Leaflet | Orihon (from `orihon/standard` or the root entry) |
| --- | --- |
| `L.control.zoom(o)` | `zoomControl(o)` |
| `L.control.scale(o)` | `scaleControl(o)` |
| `L.control.attribution(o)` | `attributionControl(o)` |
| `L.control.layers(base, overlays)` | `layersControl(base, overlays)` |
| `L.Control.extend({...})` | `customControl(content, o)`, or extend `Control` |
| `control.addTo(map)` / `control.remove()` | same |

`orihon/controls` is a *separate* optional entry holding extras Leaflet has no counterpart for:
`fullscreenControl`, `measureControl`, `miniMap` and `graticuleLayer`. The controls above are
part of Standard and need no extra import.

## Events

Payloads are flat. Leaflet's `e.latlng` and `e.containerPoint` are unchanged; anything Orihon
once mirrored under `e.detail` is gone — read the field directly.

```js
map.on("click", (event) => {
  event.latlng;         // LatLng
  event.containerPoint; // Point
  event.target;         // the map
});
```

`on`, `once`, `off` and `emit` work as in Leaflet. `off()` with no arguments clears every
handler owned by that object.

## Options that changed shape

These are the cases where a Leaflet-style boolean chose between implementations, and the
option now names the choice instead:

| Leaflet-style | Orihon |
| --- | --- |
| `fitBounds(b, { animate: true })` | `fitBounds(b, { animation: "fly" })` |
| `setView(c, z, { animate: false })` in a loop | `updateView(c, z)` |
| duration in seconds | `durationMs`, always milliseconds |
| `radius` on `L.circle` (metres) / `L.circleMarker` (pixels) | `radiusMeters` / `radiusPixels`, chosen explicitly |

`tileLayer(url)` renders DOM tiles in every entry. GPU rasters are opt-in with
`renderer: "auto"`; naming `"webgl"` or `"webgpu"` is a requirement that throws rather than
falling back, so a GPU path cannot silently become a DOM path in production.

## What has no Leaflet counterpart

Worth knowing before you conclude something is missing: `ObjectManager` for 100k+ objects,
`FeatureSource` for one dataset shared by several renderers, `heatLayer` with isolines,
`orihon/draw`, `orihon/react`, and the GPU renderers. None of them are needed to port an
existing Leaflet application — start with the table above and reach for these afterwards.

## Checklist

1. Replace `L.x(...)` with named imports.
2. Replace every map-coordinate tuple with `{ lat, lng }`; leave GeoJSON arrays alone.
3. Replace `radius` with `radiusMeters` or `radiusPixels`.
4. Replace animation booleans with `animation: "fly"`, and per-frame `setView` with `updateView`.
5. Convert seconds to `durationMs`.
6. Replace writes to `map.options` with the matching setter.
