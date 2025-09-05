# Changelog

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
