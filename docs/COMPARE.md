# Orihon vs Leaflet vs OpenLayers vs MapLibre

Feature-oriented comparison of four common browser mapping stacks.  
Status reflects typical out-of-the-box / first-party capability as of Orihon 1.0.x — not every plugin in each ecosystem.

| Symbol | Meaning |
| --- | --- |
| ● | Built-in / first-party |
| ◐ | Partial, provider-based, or common plugin |
| ○ | Not typical / not in scope |

Related: [Pricing](PRICING.md) · [API](API.md) · [Engine benchmark](../examples/bench-compare)

---

## Positioning

| | **Orihon** | **Leaflet** | **OpenLayers** | **MapLibre GL** |
| --- | --- | --- | --- | --- |
| Role | Lightweight modular map engine | Minimal DOM map library | Full GIS toolkit | WebGL vector-map renderer |
| Render model | DOM tiles + SVG/canvas; **WebGL only in Advanced** | DOM / canvas | Canvas / WebGL where used | GPU WebGL (style-driven) |
| Best fit | Product maps that want small core + GIS when needed | Simple interactive maps | Heavy GIS, many projections, editing | Styled basemaps, large vector tiles, camera effects |
| Learning curve | Low–medium (Leaflet-like API) | Low | Medium–high | Medium (style JSON) |
| Zero npm deps (runtime) | ● | ● | ● | ● |
| TypeScript | ● (authored in TS) | ◐ (community types) | ● | ● |
| License | PolyForm Noncommercial + commercial | BSD-2-Clause | BSD-2-Clause | BSD-3-Clause |

**Orihon note:** commercial production needs a paid plan; Community / PolyForm covers non-commercial use. The others are OSI-approved open source.

---

## Size and packaging

| | Orihon | Leaflet | OpenLayers | MapLibre GL |
| --- | --- | --- | --- | --- |
| Published core (approx. gzip JS) | ~14 KiB Core | ~41 KiB | ~200–300 KiB+ | ~170 KiB+ |
| Modular entry points | ● (`core` / `standard` / full) | ◐ (usually full build) | ● (ES modules) | ● |
| CSS required | ● | ● | ● | ● |
| Feature gating by build tier | ● (intentional) | ○ | ○ | ○ |

Exact bytes change by version and tree-shaking — see also `examples/bench-compare` “Measured library transfer”.

---

## Map core and interaction

| Capability | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| Pan / zoom / pinch / dblclick / box zoom | ● | ● | ● | ● |
| Inertia / keyboard nav | ● | ● | ● | ● |
| `fitBounds` / fly animations | ● | ● | ● | ● |
| Behavior toggles (drag, scrollZoom, …) | ● | ● | ● | ● |
| Multiple named panes / z-order | ● | ● | ● | ● (layers) |
| Locale / RTL-friendly controls | ● | ◐ | ◐ | ◐ |
| Built-in geolocation control | ● | ◐ (plugin) | ● | ◐ |

---

## Coordinate systems

| Capability | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| Web Mercator (EPSG:3857) | ● | ● | ● | ● |
| Other CRS / custom projections | ○ | ◐ (Proj4Leaflet) | ● | ○ (Mercator-centric) |
| Antimeridian / wrap helpers | ● | ● | ● | ● |
| Terrain / pitch / bearing camera | ○ (layer rotation helpers only) | ○ | ◐ | ● |
| Globe / 3D buildings | ○ | ○ | ○ | ● (style + fill-extrusion) |

If you need arbitrary GIS projections or true 3D camera, OpenLayers / MapLibre are the stronger defaults.

---

## Raster and imagery

| Capability | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| XYZ / TMS tile layers | ● | ● | ● | ● (raster source) |
| Retina / `{r}` / subdomain `{s}` | ● | ● | ● | ● |
| WMS | ● | ● | ● | ◐ |
| Image / video / SVG overlays | ● | ● | ● | ◐ |
| Bounded tile cache / cancel in-flight | ● | ◐ | ● | ● |
| Offline tile cache / SW helpers | ● | ◐ | ◐ | ◐ |

---

## Vector drawing (client geometries)

| Capability | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| Markers / DivIcon | ● | ● | ● | ◐ (HTML markers / symbol) |
| Polyline / polygon / circle / rectangle | ● (SVG) | ● | ● | ◐ (GeoJSON layers) |
| GeoJSON layer API | ● | ● | ● | ● (sources + layers) |
| Canvas path renderer | ◐ (canvas base / heat) | ● (`preferCanvas`) | ● | ● (GPU) |
| Interactive drawing / edit tools | ○ | ◐ (plugins) | ● | ◐ (plugins) |
| Measure / snap / topology ops | ○ | ◐ | ● | ○ |

---

## Vector tiles and large data

| Capability | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| MVT / vector tile basemap | ◐ (MVT provider + vector tile layer) | ◐ (plugins) | ● | ● (primary path) |
| Style JSON (Mapbox/MapLibre style) | ○ | ○ | ◐ | ● |
| WebGL point cloud / many points | ● (`WebGLPointLayer`) | ○ | ◐ | ● |
| Heatmap | ● | ◐ (plugin) | ● | ● |
| High-volume object manager | ● (`ObjectManager`) | ◐ (plugins) | ◐ | ◐ |
| Built-in clustering | ● (ObjectManager, hierarchical radius + WebGL) | ◐ (markercluster) | ● | ● (GeoJSON cluster) |
| Remote viewport object loader | ● (`RemoteObjectManager`) | ○ | ◐ | ◐ |
| Geometry workers | ● | ○ | ◐ | ● (internal) |

**ObjectManager** is Orihon’s differentiator for “100k+ business objects without 100k DOM nodes”: spatial index, viewport DOM, clustering. MapLibre wins when the product *is* a styled vector basemap; Orihon wins when the basemap is tiles and the hard problem is application objects / telemetry points.

---

## Popups, UI and accessibility

| Capability | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| Popup / tooltip | ● | ● | ● | ● (Popup) |
| Safe text + DOM + async mount factories | ● | ◐ | ◐ | ◐ |
| Zoom / scale / attribution controls | ● | ● | ● | ● |
| Layers control | ● | ● | ● | ◐ |
| Custom controls | ● | ● | ● | ● |
| ARIA labels on map chrome | ● | ◐ | ◐ | ◐ |

---

## Search, routing and traffic

| Capability | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| Geocoding / suggest UI | ◐ (provider hooks + suggest widget) | ◐ | ◐ | ◐ |
| Routing layer | ◐ (provider-based) | ◐ | ◐ | ◐ |
| Traffic layer | ◐ (provider-based) | ◐ | ◐ | ◐ |
| Bundled map service account | ○ | ○ | ○ | ○ |

All four treat geocoders/routers as bring-your-own. Orihon ships the adapter surfaces; it does not host tiles or routing.

---

## Platform and integration

| Capability | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| Framework-agnostic | ● | ● | ● | ● |
| React / Vue / Svelte bindings | ◐ (thin adapters / WC) | ◐ (ecosystem) | ◐ | ◐ |
| Web Component helper | ● | ○ | ○ | ○ |
| Performance inspector helpers | ● | ○ | ○ | ◐ (debug APIs) |
| Mobile browsers | ● | ● | ● | ● |
| Node / headless map render | ○ | ○ | ◐ | ◐ |

---

## Ecosystem maturity

| | Orihon | Leaflet | OpenLayers | MapLibre |
| --- | --- | --- | --- | --- |
| Years in market | New (1.x) | Very high | Very high | High (Mapbox GL lineage) |
| Plugin / example volume | Low | Very high | High | High |
| Hiring / Stack Overflow density | Low | Very high | High | High |
| Corporate stewardship | Independent | Independent | OSGeo-related community | MapLibre org |

Choose Leaflet/OL/MapLibre when ecosystem gravity matters more than package size. Choose Orihon when you want a small licensed engine with ObjectManager / tiered imports and are fine owning more of the stack.

---

## When to pick which

| Need | Prefer |
| --- | --- |
| Smallest dependency for a product map + optional GIS | **Orihon** |
| Fastest path + huge plugin catalog | **Leaflet** |
| Arbitrary CRS, advanced editing, GIS workflows | **OpenLayers** |
| Mapbox-style vector basemap, pitch/bearing, GPU tiles | **MapLibre GL** |
| 100k+ app objects on a raster basemap | **Orihon** (`ObjectManager` / `WebGLPointLayer`) |
| Pure noncommercial / OSS-only compliance | Leaflet / OpenLayers / MapLibre |
| Commercial product with clear yearly entity license | **Orihon** commercial plans |

---

## Side-by-side “hello map”

All four can show OSM tiles in a few lines. Conceptual shape:

```text
Orihon     createMap → tileLayer
Leaflet    L.map → L.tileLayer
OpenLayers ol.Map → ol.layer.Tile + XYZ
MapLibre   maplibregl.Map → style with raster source
            (or vector style URL)
```

Orihon’s API is intentionally close to Leaflet-style `addTo` / `setView` / `fitBounds`, while MapLibre is style-and-source oriented, and OpenLayers is layer/source/view oriented.

---

## Benchmarks

Runtime comparison (points, clusters, live updates, pick) lives in:

[`examples/bench-compare`](../examples/bench-compare) — `npm run demo:bench`

Treat benchmarks as workload-specific. WebGL engines diverge on memory layout; clustering fairness depends on whether `moveend` rebuilds every frame.

---

## Summary

- **Leaflet** — simplest, most familiar, DOM-first.
- **OpenLayers** — broadest classic GIS surface.
- **MapLibre** — strongest GPU / vector-tile / camera stack.
- **Orihon** — smallest modular alternative with Leaflet-like DX, tiered bundles, and first-party high-volume object tooling under a commercial dual-license model.

This document is descriptive, not a substitute for each project’s own docs and licenses.
