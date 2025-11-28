# Orihon — engine benchmark

Comparative browser bench: **Orihon**, **Leaflet**, **OpenLayers**, **MapLibre GL**.

Self-contained `index.html` — open the file directly (libraries load from CDN). No build or local server required.

Live: https://whahedev.github.io/orihon/bench/

## Scenarios

| Scenario | What it stresses |
| --- | --- |
| **Points** | Static N points — Orihon `WebGLPointLayer`, MapLibre **raw GL buffer** (fair), Leaflet canvas, OL vector |
| **Clusters** | Orihon `ObjectManager`, Leaflet.markercluster, OL `Cluster`, MapLibre GeoJSON cluster. Camera = **discrete** view steps |
| **Heatmap** | Shared hub-weighted dataset + `HEAT_BENCH` paint |
| **Isolines** | Orihon `heatIsolineLayer` (Leaflet / OL / MapLibre: n/a) |
| **GeoJSON** | N LineString features |
| **Markers** | DOM markers **hard-capped at 5k** |
| **Chart popup** | Marker open latency with chart content |
| **Filter** | Clustered set with filter toggled on camera steps |
| **Rich OM** | ObjectManager / MapLibre rich styles, filter, popup, live batches |
| **Live updates** | Move ~20% of points every frame for ~3s |
| **Pick** | Shared project+nearest scan |
| **Basemap** | Tiles only |

## Metrics

| Metric | Meaning |
| --- | --- |
| Init | Map + basemap construction |
| Load | Add data + first settled frames |
| FPS | Avg during camera / live stress (`60≈` = vsync-capped) |
| p95 / max | Frame-time tail |
| drop% | Frames slower than ~18.2 ms |
| Pick / Open | Hit-test / popup open latency |
| Markers | Visible count after load |
| Heap | Chromium `performance.memory` |

**Runs = 3 → median** reduces tile/GC noise.

## Notes

- Engines run **sequentially**.
- MapLibre points/live use a custom mercator buffer layer so Heap is comparable to Orihon.
- DOM markers above ~5k and GeoJSON above ~25k are intentionally warned.
- Export JSON after a completed run.
