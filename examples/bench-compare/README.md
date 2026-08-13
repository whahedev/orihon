# Orihon — engine benchmark

Comparative browser bench: **Orihon**, **Leaflet**, **OpenLayers**, **MapLibre GL**.

## Scenarios

| Scenario | What it stresses |
| --- | --- |
| **Points** | Static N points — Orihon `WebGLPointLayer`, MapLibre **raw GL buffer** (fair), Leaflet canvas, OL vector |
| **Clusters** | Orihon `ObjectManager`, Leaflet.markercluster, OL `Cluster`, MapLibre GeoJSON cluster. Camera = **discrete** view steps (fair for moveend reclusters) |
| **Heatmap** | **One shared** hub-weighted dataset + `HEAT_BENCH` paint. Heap = absolute tab JS heap with engine live; stage cleared + GC settle before each engine |
| **Isolines** | Orihon `heatIsolineLayer` — density field + marching-squares contours on moveend (discrete camera). **Leaflet / OpenLayers / MapLibre: n/a** — no built-in heat→isolines (Turf/plugins or DEM contour tools are a different feature) |
| **GeoJSON** | N LineString features — Orihon DOM tiles + `geoJSON` WebGL lines; Leaflet GeoJSON+canvas; OL Vector; MapLibre line layer |
| **Markers** | DOM markers **hard-capped at 5k**. Orihon `MarkerCollection` (viewport cull). For 50k+ use Points / `markerCollection({ renderer: "auto" })` |
| **Chart popup** | Marker count = Points (max 5k). Load all markers with charts; stress hops **≤40** times across the set with zoom; Open p50/p95 |
| **Filter** | Clustered set with filter toggled every discrete camera step (~⅔ active) |
| **Rich OM** | Orihon ObjectManager + MapLibre GeoJSON: category styles, filter, popup, hover/select, live batches; optional native clustering. Toggle **Clusters**. Leaflet/OL = n/a |
| **Live updates** | Move ~20% of points every frame for ~3s |
| **Pick** | Same O(n) project+nearest scan; samples projected from real points |
| **Basemap** | Tiles only — Orihon `webglTileLayer` vs Leaflet / OL / MapLibre raster |

## Metrics

| Metric | Meaning |
| --- | --- |
| Init | Map + basemap construction |
| Load | Add data + first settled frames |
| FPS | Avg during camera / live stress (`60≈` = vsync-capped) |
| p95 / max | Frame-time tail |
| drop% | Share of frames slower than ~18.2 ms (55 FPS budget; ignores normal 60 Hz jitter) |
| Pick p50/p95 | Hit-test latency |
| Open p50/p95 | Chart popup open latency (Chart popup scenario) |
| Markers | Visible cluster/marker count after load / filter stress |
| Heap | Chromium `performance.memory` |

**Runs = 3 → median** reduces tile/GC noise.

## Presets

- Marketing 50k — points × median
- Stress 250k — points × 1 run
- Stress 1M (no clusters) — bare WebGL points × 1 run (prefer Orihon + MapLibre only)
- Rich 1M (with clusters) — ObjectManager / MapLibre GeoJSON full stack × 1 run
- Rich 1M (no clusters) — same features without clustering (better for styles/hover) × 1 run
- ObjectManager 50k — clusters
- Heatmap 50k
- Isolines 25k
- GeoJSON 5k
- Markers 5k
- Chart popup 100
- Filter 50k
- Live 50k / Pick 50k
- Basemap — tiles only

## Large marker sets (50k+)

Do **not** call `marker(ll).addTo(map)` in a loop for tens of thousands of points. Use:

```js
import { markerCollection, webglPointLayer, objectManager } from "orihon";

// Auto: WebGL when N ≥ 2500
markerCollection(points, { renderer: "auto" }).addTo(map);

// Or always GPU
webglPointLayer(points, { pointSize: 8 }).addTo(map);

// Or ObjectManager without clustering (auto WebGL above threshold)
objectManager({ clusterize: false, clusterRenderer: "auto" }).add(objects).addTo(map);
```

## Run

Local (uses `/dist` when present, else CDN Orihon):

```bash
npm run build
npm run demo:bench
```

Open http://localhost:4176/examples/bench-compare/

Live: https://whahedev.github.io/orihon/bench/

Leaflet / OpenLayers / MapLibre still load from CDN. Export JSON after a completed run.

## Notes

- Engines run **sequentially**.
- MapLibre **points/live** use a custom mercator buffer layer (not GeoJSON) so Heap is comparable to Orihon.
- Clusters / filter still use MapLibre’s GeoJSON cluster source (native feature). Camera stress uses discrete steps so ObjectManager / markercluster are not forced to rebuild 60×/sec.
- Pick uses one shared algorithm (project + nearest) so results compare projection cost, not mismatched APIs.
- Leaflet.markercluster above ~100k can freeze the tab — use the warning / lower N.
- DOM **markers** above ~5k and **GeoJSON** above ~25k are intentionally warned; use presets.
