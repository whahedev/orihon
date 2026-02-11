# Recipes

## A Small Raster Map

```js
import { createMap, tileLayer, marker } from "orihon/standard";
import "orihon/orihon.css";

const map = createMap("map", { center: ({ lat: 52.52, lng: 13.405 }), zoom: 11 });
tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
  maxRequests: 8,
  cacheSize: 160
}).addTo(map);
marker(({ lat: 52.52, lng: 13.405 })).bindPopup("Center").addTo(map);
```

## A Bounded WMS Dataset

```js
import { wmsTileLayer } from "orihon";

wmsTileLayer("/wms", {
  layers: "planning:zones",
  version: "1.3.0",
  crs: "EPSG:3857",
  format: "image/png",
  transparent: true,
  bounds: [({ lat: 52.50, lng: 13.35 }), ({ lat: 52.54, lng: 13.45 })]
}).addTo(map);
```

Use `setParams({ layers: "planning:routes" })` to change the visible service layer without replacing the WMS object.

## 10,000 To 100,000 Points

Use `objectManager` for interactive clustered objects and `webglPointLayer` for raw point density:

```js
import { objectManager, webglPointLayer } from "orihon";

const objects = objectManager({ clusterize: true, clusterRadiusPixels: 50 }).addTo(map);
objects.add(featureCollection);

const density = webglPointLayer(points, { pointSize: 4, color: "#e11d48" }).addTo(map);
density.setViewTransform({ rotation: 20, pitch: 30 });
```

## Heatmap

Use `heatLayer` for weighted point density with blur and a color gradient:

```js
import { heatLayer } from "orihon";

const points = [
  [52.52, 13.405, 0.8],
  [52.53, 13.41, 1],
  [52.515, 13.39, 0.5]
];

heatLayer(points, {
  radius: 28,
  blur: 18,
  scaleZoom: 12,
  max: 3,
  minOpacity: 0.08
}).addTo(map);
```

`scaleZoom` is the zoom where `radius` is the geographic bandwidth. The kernel grows and shrinks with mercator zoom; `max` is how many overlapping unit kernels map to red. A uniform field stays the same color at every zoom instead of turning red when you zoom out.

## Binary Vector Tiles

```js
import { createMVTProvider, vectorTileLayer } from "orihon";

const provider = createMVTProvider("/mvt/{z}/{x}/{y}.pbf", {
  layer: ["roads", "water"]
});

vectorTileLayer({
  provider,
  style: (feature) => ({
    stroke: feature.properties?.class === "motorway" ? "#e11d48" : "#475569",
    strokeWidth: feature.properties?.class === "motorway" ? 4 : 2
  })
}).addTo(map);
```

## Offline Tile Cache

```js
import { offlineTileCache } from "orihon";

const cache = offlineTileCache({ cacheName: "city-v1", maxEntries: 500 });
await cache.prefetch(urls, { concurrency: 6 });
await cache.registerServiceWorker({
  urlPrefixes: ["https://tile.openstreetmap.org/"],
  scope: "/"
});
```

Cache only sources whose terms permit offline storage. Bump the cache name when tile content or style versions change.

## Cleanup In Single-Page Applications

```js
import { createMap, objectManager } from "orihon";

const map = createMap(container, options);
const remote = objectManager({ loader }).addTo(map);

return () => {
  remote.remove();
  map.remove();
};
```

Removing the map aborts layer work, disconnects resize observation and releases DOM listeners. Provider-owned timers or sockets remain the provider's responsibility.

## Charts, Images And Video In Popups

Return a DOM node for native browser content:

```js
layer.bindPopup(() => {
  const card = document.createElement("section");
  const image = document.createElement("img");
  image.src = "/previews/camera-12.jpg";
  const video = document.createElement("video");
  video.src = "/streams/camera-12.mp4";
  video.controls = true;
  card.append(image, video);
  return card;
});
```

Use mountable content when another library owns resources:

```js
layer.bindPopup((context) => ({
  mount(container) {
    const root = createFrameworkRoot(container);
    root.render({ selected: context.data });
    return () => root.destroy();
  }
}));
```

The returned cleanup is called exactly once for each successful mount. Async factories may fetch details using application-owned cancellation logic; Orihon ignores their result if the popup has already closed.
