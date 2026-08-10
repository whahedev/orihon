# Orihon Lab

Interactive playground for the full Orihon surface: basemaps, vectors, GeoJSON, overlays, ObjectManager, WebGL points, heatmap, routing/search stubs, controls and events.

## Run

CDN-backed (no build):

```bash
npx --yes serve examples/lab -p 4274
```

Open http://127.0.0.1:4274/

Or with the local demo WMS server:

```bash
npm run demo:lab
```

Open http://127.0.0.1:4274/demo/index.html

Live: https://whahedev.github.io/orihon/lab/

WMS tiles work offline of the Node server via `wms-sw.js` (Service Worker mock).
