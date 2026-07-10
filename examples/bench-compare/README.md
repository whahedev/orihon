# Orihon — engine benchmark

Comparative browser bench: **Orihon**, **Leaflet**, **OpenLayers**, **MapLibre GL**.

`npm run demo:bench` first rebuilds Orihon and serves the repository, so the benchmark uses the current local `dist`. Opening `index.html` directly remains supported and uses the pinned CDN fallback.

Pinned comparison set (verified 2026-08-21): Orihon 2.0.1, Leaflet 1.9.4, Leaflet.markercluster 1.5.3, OpenLayers 10.10.0 and MapLibre GL 6.4.1. Keep pins explicit so exported results remain reproducible; update this table and all CSS/JS URLs together. MapLibre v6 is loaded through its ESM-only `maplibre-gl.mjs` entry.

Live: https://whahedev.github.io/orihon/bench/

## Scenarios

| Scenario | What it stresses |
| --- | --- |
| **Points** | Static N points — Orihon `WebGLPointLayer`, MapLibre **raw GL buffer** (fair), Leaflet canvas, OL vector |
| **Clusters** | Orihon `ObjectManager`, Leaflet.markercluster, OL `Cluster`, MapLibre GeoJSON cluster. Camera = **discrete** view steps |
| **Heatmap** | Shared hub-weighted dataset replaced by `orihon-mark-shape-v1`: sources trace the accordion-map mark silhouette; Orihon `heatLayer` continuous scalar-field colors |
| **Isolines** | Orihon `heatLayer` WASM field + marching-squares stitching (Leaflet / OL / MapLibre: n/a) |
| **Heatmap + isolines** | Orihon renders colors, matching contours and labels from one scalar field |
| **GeoJSON** | N four-vertex LineStrings; Orihon streams disposable chunks into a packed WebGL buffer |
| **Markers** | Marker renderers **hard-capped at 5k**; Orihon keeps all 5k in DOM (≤500 HTML buttons + SVG DOM remainder), Leaflet uses HTML, OpenLayers canvas, MapLibre ≤500 HTML + GPU |
| **Chart popup** | Marker open latency with chart content |
| **Filter** | Clustered set with filter toggled on camera steps |
| **Rich OM** | ObjectManager / MapLibre rich styles, filter, popup, live batches |
| **Live updates** | Move ~20% of points every frame for ~3s |
| **Pick** | Shared project+nearest scan |
| **Basemap** | Tiles only |
| **Tile scroll / zoom-out** | One fractional zoom-in → zoom-out round-trip, alternating edge exposure, cache reuse and final tile-settle latency |

## Metrics

| Metric | Meaning |
| --- | --- |
| Init | Map + basemap construction |
| Load | Add data + first settled frames |
| Field / Contours / Paint | Orihon heat breakdown inside Load; field/contours exclude source packing and map/tile setup |
| FPS | Avg during camera / live stress (`60≈` = vsync-capped) |
| p95 / max | Frame-time tail |
| drop% | Frames slower than ~18.2 ms |
| Pick / Open | Hit-test / popup open latency |
| Markers | Visible count after load |
| Heap | Chromium `performance.memory`: absolute live heap plus delta from the reclaimed pre-run baseline; median runs also report retained baseline growth |

The tile-scroll scenario also reports **Settle**, each engine's tile-pipeline **Requests**, and repeated coordinate/URL **Reloads** inside the same run. This exposes zoom-out cache regressions instead of hiding them behind average FPS. Browser HTTP-cache hits still count when an engine restarts its own tile pipeline, because decode/upload and bookkeeping are part of the user-visible cost.

**Runs = 3 → median** reduces tile/GC noise.

## Notes

- Engines run **sequentially**.
- Heat rows use `orihon-mark-shape-v1`: point sources follow the Orihon accordion-map mark (panels, strokes, route, end nodes), radius 5 px, blur 16 px, opacity 72% and the shared thermal ramp. Orihon also receives the captured 512×384 static field, Worker/WASM, 32 contour levels and selection weights. Leaflet/OpenLayers receive their native radius+blur controls. MapLibre has no separate blur control, so the benchmark uses one equivalent 21 px kernel. The **Temperature profile 1M** preset selects this scenario, one run and every engine. Exported JSON embeds the complete heat profile.
- Orihon heat sources are packed cooperatively with `setDataAsync()`. The v2 field aggregates weighted sources into cluster-like cells, then runs separable Gaussian passes in WASM/WebGPU; `auto` considers WebGPU at 100k+ in all display modes and reports readback separately. Static rows evaluate the full dataset once, zoom-refined rows rebuild in a persistent Worker, and camera motion compositor-warps the last complete surface.
- MapLibre points/live use a custom mercator buffer layer so Heap is comparable to Orihon.
- Orihon's mass GeoJSON row uses `retainFeatures:false`; it measures write-once rendering, not source round-trip or later per-feature restyling. Continuous camera motion mixes cheap camera-warp frames with throttled exact GPU redraws, then waits for the final exact settled frame.
- DOM markers above ~5k and GeoJSON above ~25k are intentionally warned. Above 50k LineStrings, Leaflet/OpenLayers per-feature rows return `n/a`; Orihon keeps its disposable packed-chunk path, while MapLibre receives the same paths as bounded `MultiLineString` features through a valid GeoJSON Blob URL so its worker does not first clone one million main-thread `Feature` objects.
- Export JSON after a completed run.
- The Node CPU/RAM companion benchmark is `npm run bench:object-manager`; it imports only the public package entry and prints the Orihon, Node, OS and architecture versions with every run.
