# Changelog

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
