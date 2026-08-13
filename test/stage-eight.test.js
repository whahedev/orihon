import test from "node:test";
import assert from "node:assert/strict";
import { Evented } from "../dist/events.js";
import { clusterLayoutWorkerSource } from "../dist/services/cluster-layout.js";
import {
  OfflineTileCache,
  PerformanceInspector,
  VectorTileLayer,
  WebGLPointLayer,
  HeatLayer,
  WebGLHeatLayer,
  MarkerCollection,
  buildClusterIndex,
  buildHeatIsolines,
  createMVTProvider,
  createMapAdapter,
  decodeMVT,
  defineOrihonElement,
  geometryWorkerPool,
  heatIsolineLayer,
  heatLayer,
  markerCollection,
  offlineTileCache,
  performanceInspector,
  preparePointBatch,
  queryClusterLayout,
  vectorTileLayer,
  webglHeatLayer,
  webglPointLayer
} from "../dist/index.js";
import { prefetchUrlAllowed } from "../dist/services/offline-cache.js";

class FakeClassList {
  values = new Set();
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = new Map();
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.width = 0;
    this.height = 0;
  }
  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelectorAll() { return this.children; }
  getContext(type) {
    if (this.tagName !== "canvas" || type !== "2d") return null;
    return new FakeCanvasContext(this);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
  }
  clearRect() {}
  setTransform() {}
  createLinearGradient() {
    return { addColorStop() {} };
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
  fillRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  stroke() {}
  fillText() {}
  save() {}
  restore() {}
  arc() {}
  fill() {}
  drawImage() {}
  getImageData(_x, _y, w, h) {
    return { data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData() {}
}

globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  getElementById: () => null
};
globalThis.window = new FakeElement();
globalThis.requestAnimationFrame = (callback) => {
  callback?.(16);
  return 1;
};
globalThis.cancelAnimationFrame = () => {};

test("HeatLayer stores weighted points and attaches a canvas overlay", () => {
  class FakeMap extends Evented {
    zoom = 12;
    panes = { overlay: new FakeElement() };
    layers = new Set();
    getZoom() { return this.zoom; }
    getSize() { return { x: 800, y: 600 }; }
    getPane(name) { return this.panes[name] ?? null; }
    latLngToContainerPoint([lat, lng]) {
      return { x: (lng + 180) * 2, y: (90 - lat) * 2 };
    }
    addLayer(layer) {
      this.layers.add(layer);
      layer.onAdd(this);
      layer.render();
    }
    removeLayer(layer) {
      if (!this.layers.delete(layer)) return;
      layer.onRemove();
    }
  }

  const layer = heatLayer([
    [52.52, 13.405, 0.8],
    [52.53, 13.41],
    { lat: 52.515, lng: 13.39 }
  ], { radius: 28, blur: 18, scaleZoom: 12 });

  assert.ok(layer instanceof HeatLayer);
  assert.equal(layer.options.radius, 28);
  layer.addLatLng([52.51, 13.38, 1]);
  layer.setLatLngs([[52.52, 13.405, 1]]);

  const map = new FakeMap();
  layer.addTo(map);
  assert.equal(map.panes.overlay.children.length, 1);
  assert.equal(map.panes.overlay.children[0].className, "oh-heat-layer");
  layer.remove();
  assert.equal(map.panes.overlay.children.length, 0);
});

test("WebGLHeatLayer packs mercator+weight and exposes count", () => {
  const layer = webglHeatLayer([
    [52.52, 13.405, 0.8],
    { lat: 52.53, lng: 13.41 },
    [Number.NaN, 1]
  ], { radius: 20 });
  assert.ok(layer instanceof WebGLHeatLayer);
  assert.equal(layer.count, 2);
  assert.equal(layer.data.length, 6);
  assert.ok(layer.data[2] > 0.7 && layer.data[2] < 0.9);
  layer.setData([[50, 10, 1], [51, 11, 0.5]]);
  assert.equal(layer.count, 2);
  assert.equal(layer.getStats().points, 2);
  layer.clear();
  assert.equal(layer.count, 0);
});

test("WebGLHeatLayer and HeatIsolineLayer keep points across remove/add", () => {
  class FakeMap extends Evented {
    zoom = 10;
    size = { width: 800, height: 600 };
    pixelOrigin = { x: 0, y: 0 };
    panes = { overlay: new FakeElement() };
    layers = new Set();
    getZoom() { return this.zoom; }
    getSize() { return { x: 800, y: 600 }; }
    getBounds() { return [[52.4, 13.3], [52.6, 13.5]]; }
    getPane(name) { return this.panes[name] ?? null; }
    latLngToContainerPoint([lat, lng]) {
      return { x: (lng + 180) * 2, y: (90 - lat) * 2 };
    }
    addLayer(layer) {
      this.layers.add(layer);
      layer.onAdd(this);
      return this;
    }
    removeLayer(layer) {
      if (!this.layers.delete(layer)) return this;
      layer.onRemove();
      return this;
    }
    hasLayer(layer) { return this.layers.has(layer); }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const heat = webglHeatLayer([[52.52, 13.405, 1], [52.53, 13.41, 0.5]]);
  heat.addTo(map);
  assert.equal(heat.count, 2);
  heat.remove();
  assert.equal(heat.count, 2);
  heat.addTo(map);
  assert.equal(heat.count, 2);
  assert.ok(map.hasLayer(heat));
  heat.remove();

  const isolines = heatIsolineLayer([[52.52, 13.405, 1], [52.53, 13.41, 0.5]], {
    levels: 3,
    dynamic: false,
    labels: false
  });
  isolines.addTo(map);
  assert.equal(isolines.count, 2);
  isolines.remove();
  assert.equal(isolines.count, 2);
  isolines.addTo(map);
  assert.equal(isolines.count, 2);
  assert.ok(map.hasLayer(isolines));
});

test("WebGLHeatLayer aggregates dense points at low zoom", () => {
  const points = [];
  for (let i = 0; i < 200; i++) {
    points.push([52.5 + (i % 10) * 0.0002, 13.4 + Math.floor(i / 10) * 0.0002, 1]);
  }
  const layer = webglHeatLayer(points, {
    radius: 24,
    blur: 15,
    scaleZoom: 10,
    aggregate: true,
    aggregateCellFactor: 0.45
  });
  layer.prepare(5);
  const low = layer.getStats();
  assert.equal(low.points, 200);
  assert.ok(low.aggregated < 150, `expected aggregation, got ${low.aggregated}`);

  layer.prepare(16);
  const high = layer.getStats();
  assert.ok(high.aggregated >= low.aggregated, "higher zoom should keep more cells");
  assert.ok(high.aggregated <= 200);
});

test("WebGLHeatLayer marks moving via map move then settles", async () => {
  class FakeMap extends Evented {
    zoom = 8;
    size = { width: 800, height: 600 };
    pixelOrigin = { x: 0, y: 0 };
    panes = { overlay: new FakeElement() };
    layers = new Set();
    getZoom() { return this.zoom; }
    getSize() { return { x: 800, y: 600 }; }
    getPane(name) { return this.panes[name] ?? null; }
    addLayer(layer) {
      this.layers.add(layer);
      layer.onAdd(this);
      return this;
    }
    removeLayer(layer) {
      if (!this.layers.delete(layer)) return this;
      layer.onRemove();
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const layer = webglHeatLayer([[52.5, 13.4]], { aggregate: false });
  layer.addTo(map);
  assert.equal(layer.getStats().moving, false);
  map.emit("move", { center: [52.5, 13.4] });
  assert.equal(layer.getStats().moving, true);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(layer.getStats().moving, false);
  layer.remove();
});

test("buildHeatIsolines extracts rings from a dense cluster", () => {
  const points = [];
  for (let i = 0; i < 80; i++) {
    const a = (i / 80) * Math.PI * 2;
    points.push([50.1 + Math.cos(a) * 0.15, 14.4 + Math.sin(a) * 0.25, 1]);
  }
  for (let i = 0; i < 40; i++) points.push([50.1, 14.4, 1]);

  const result = buildHeatIsolines(points, [[49.6, 13.6], [50.6, 15.2]], {
    cols: 64,
    rows: 48,
    radius: 32,
    blur: 12,
    zoom: 7,
    scaleZoom: 7,
    levels: 4
  });
  assert.ok(result.peak > 0);
  assert.ok(result.rings.length >= 2, `expected isoline rings, got ${result.rings.length}`);
  for (const ring of result.rings) {
    assert.ok(ring.coordinates.length >= 2);
    assert.ok(ring.t > 0 && ring.t <= 1);
  }
});

test("MarkerCollection auto picks webgl above threshold", () => {
  class FakeMap extends Evented {
    zoom = 10;
    size = { width: 800, height: 600 };
    pixelOrigin = { x: 0, y: 0 };
    panes = { overlay: new FakeElement(), marker: new FakeElement() };
    layers = new Set();
    getZoom() { return this.zoom; }
    getSize() { return { x: 800, y: 600 }; }
    getBounds() { return [[0, 0], [1, 1]]; }
    getPane(name) { return this.panes[name] ?? null; }
    latLngToLayerPoint(ll) {
      const lat = Array.isArray(ll) ? ll[0] : ll.lat;
      const lng = Array.isArray(ll) ? ll[1] : ll.lng;
      return { x: lng * 10, y: lat * 10 };
    }
    addLayer(layer) {
      this.layers.add(layer);
      layer.onAdd(this);
      layer.render();
      return this;
    }
    removeLayer(layer) {
      if (!this.layers.delete(layer)) return this;
      layer.onRemove();
      return this;
    }
    on() { return this; }
    off() { return this; }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const points = [];
  for (let i = 0; i < 30; i++) points.push([52.5 + i * 0.01, 13.4 + i * 0.01]);

  const small = markerCollection(points, { renderer: "auto", webglThreshold: 100 });
  assert.ok(small instanceof MarkerCollection);
  assert.equal(small.size, 30);

  const map = new FakeMap();
  small.addTo(map);
  assert.equal(small.renderer, "dom");
  small.remove();

  const largePts = [];
  for (let i = 0; i < 120; i++) largePts.push([52 + (i % 10) * 0.1, 13 + Math.floor(i / 10) * 0.1]);
  const large = markerCollection(largePts, { renderer: "auto", webglThreshold: 50 });
  large.addTo(map);
  assert.equal(large.renderer, "webgl");

  // Icon LOD: high zoom forces DOM markers even above the WebGL threshold.
  const lod = markerCollection(largePts, {
    renderer: "auto",
    webglThreshold: 50,
    iconMinZoom: 14,
    marker: { className: "oh-lod-icon" }
  });
  map.zoom = 10;
  lod.addTo(map);
  assert.equal(lod.renderer, "webgl");
  map.zoom = 15;
  lod.redraw();
  assert.equal(lod.renderer, "dom");
  lod.remove();
  large.remove();
});

test("WebGLPointLayer stores large point batches compactly", () => {
  const layer = webglPointLayer([
    [52.52, 13.405],
    { coordinates: [52.53, 13.41] },
    { lat: Number.NaN, lng: 1 }
  ]);

  assert.ok(layer instanceof WebGLPointLayer);
  assert.equal(layer.getStats().points, 2);
  assert.equal(layer.getStats().bufferBytes, 64);
  layer.addData([{ latlng: [52.54, 13.42] }]);
  assert.equal(layer.getStats().points, 3);
  assert.equal(layer.mercator.length, 6);
  layer.setViewTransform({ rotation: 25, pitch: 35 });
  assert.equal(layer.options.rotation, 25);
  assert.equal(layer.options.pitch, 35);
  layer.bindPopup((context) => String(context.event?.index));
  assert.equal(layer.options.interactive, true);
  assert.ok(layer.getPopup());
});

test("WebGLPointLayer reuses CPU buffers on repeated setData", () => {
  const layer = webglPointLayer([[1, 2], [3, 4]], { interactive: false });
  const firstLat = layer.points.buffer;
  const firstMerc = layer.mercator.buffer;
  layer.setData([[5, 6], [7, 8]]);
  assert.equal(layer.getStats().points, 2);
  assert.equal(layer.points.buffer, firstLat);
  assert.equal(layer.mercator.buffer, firstMerc);
  layer.setData([[9, 10], [11, 12], [13, 14]]);
  assert.equal(layer.getStats().points, 3);
});

test("WebGLPointLayer accepts per-point RGBA colors", () => {
  const layer = webglPointLayer(
    [
      [52.5, 13.4],
      [52.51, 13.41],
      [52.52, 13.42]
    ],
    { pointSize: 4, fallbackCanvas: true }
  );
  const colors = new Float32Array([
    1, 0, 0, 1,
    0, 1, 0, 1,
    0, 0, 1, 1
  ]);
  layer.setData(
    [
      [52.5, 13.4],
      [52.51, 13.41],
      [52.52, 13.42]
    ],
    { colors }
  );
  const stats = layer.getStats();
  assert.equal(stats.points, 3);
  assert.equal(stats.vertexColors, true);
  assert.equal(layer.colors.length, 12);
  layer.setColors(null);
  assert.equal(layer.getStats().vertexColors, false);
});

test("WebGLPointLayer keeps distinct screen positions at high zoom", () => {
  class FakeMap extends Evented {
    zoom = 19;
    size = { width: 800, height: 600 };
    // Rough pixel origin for Berlin @ z19.
    pixelOrigin = { x: 72106240, y: 44017120 };
    panes = { overlay: { children: [], appendChild() {}, removeChild() {} } };
    layers = new Set();
    container = { getBoundingClientRect() { return { left: 0, top: 0 }; } };
    getZoom() { return this.zoom; }
    getSize() { return this.size; }
    getPane() { return this.panes.overlay; }
    addLayer(layer) {
      this.layers.add(layer);
      layer.onAdd(this);
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      layer.onRemove();
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push([52.52 + i * 0.00002, 13.405 + i * 0.00003]);
  }
  const layer = webglPointLayer(points, { pointSize: 4, fallbackCanvas: true });
  layer.addTo(map);
  // Force canvas path projection (float64) — screen X values must not collapse.
  layer.renderer = "canvas";
  layer.render();
  const stats = layer.getStats();
  assert.equal(stats.points, 40);
  assert.ok(stats.rendered >= 2, `expected multiple rendered points, got ${stats.rendered}`);
  layer.remove();
});

test("GeometryWorkerPool prepares typed point batches with fallback", async () => {
  const batch = preparePointBatch([[1, 2], { lat: 3, lng: 4 }, { coordinates: [Number.NaN, 0] }]);
  assert.equal(batch.count, 2);
  assert.equal(batch.skipped, 1);
  assert.ok(batch.points instanceof Float32Array);

  const pool = geometryWorkerPool({ useWorker: false });
  const prepared = await pool.preparePoints([[5, 6]]);
  assert.equal(prepared.count, 1);
  pool.destroy();
});

test("GeometryWorkerPool.clusterLayout matches sync buildClusterLayout", async () => {
  const request = {
    ids: [1, 2, 3],
    coords: new Float64Array([52.52, 13.405, 52.521, 13.406, 60, 30]),
    zoomBucket: 10,
    gridSize: 256,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 18
  };
  const pool = geometryWorkerPool({ useWorker: false });
  const result = await pool.clusterLayout(request);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.singles.length, 1);
  pool.destroy();
});

test("cluster worker source is valid JavaScript", () => {
  const source = clusterLayoutWorkerSource();
  assert.match(source, /buildClusterIndex/);
  assert.equal(typeof new Function(source), "function");
});

test("GeometryWorkerPool.clusterIndex matches sync buildClusterIndex", async () => {
  const request = {
    ids: [1, 2, 3],
    coords: new Float64Array([52.52, 13.405, 52.521, 13.406, 60, 30]),
    gridSize: 256,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 18
  };
  const sync = buildClusterIndex(request);
  const pool = geometryWorkerPool({ useWorker: false });
  const viaPool = await pool.clusterIndex(request);
  assert.equal(viaPool.leafCount, sync.leafCount);
  assert.equal(viaPool.nodeCount, sync.nodeCount);
  const syncLayout = queryClusterLayout(sync, 10);
  const poolLayout = queryClusterLayout(viaPool, 10);
  assert.equal(poolLayout.clusters.length, syncLayout.clusters.length);
  assert.equal(poolLayout.singles.length, syncLayout.singles.length);
  pool.destroy();
});

test("PerformanceInspector snapshots map size, layers and tile cache stats", () => {
  const map = {
    container: new FakeElement(),
    layers: new Set([{ tiles: new Map([[1, 1]]), previousTiles: new Map(), cache: new Map([[2, 2]]) }]),
    controls: new Set([1, 2])
  };
  const inspector = performanceInspector(map);
  const snapshot = inspector.snapshot();

  assert.ok(inspector instanceof PerformanceInspector);
  assert.equal(snapshot.layers, 1);
  assert.equal(snapshot.controls, 2);
  assert.deepEqual(snapshot.tiles, { active: 1, retained: 0, cached: 1 });
});

test("OfflineTileCache exposes unsupported fallback stats without Cache API", async () => {
  const cache = offlineTileCache({ cacheName: "test-cache", fetcher: undefined });
  const stats = await cache.prefetch(["/a.png", "/a.png", "/b.png"]);

  assert.ok(cache instanceof OfflineTileCache);
  assert.equal(stats.cacheName, "test-cache");
  assert.equal(stats.queued, 2);
  assert.match(cache.createServiceWorkerScript(), /test-cache/);
  assert.match(cache.createServiceWorkerScript({ urlPrefixes: ["https://tiles.example/"] }), /tiles\.example/);
  assert.match(cache.createServiceWorkerScript(), /ORIHON_URL_PREFIXES/);
  assert.match(cache.createServiceWorkerScript(), /response\.type !== "opaque"/);
});

test("prefetch rejects blocked schemes and honors urlPrefixes", async () => {
  assert.equal(prefetchUrlAllowed("javascript:alert(1)"), false);
  assert.equal(prefetchUrlAllowed("data:text/plain,x"), false);
  assert.equal(prefetchUrlAllowed("blob:https://example/1"), false);
  assert.equal(prefetchUrlAllowed("https://tiles.example/1.png"), true);
  assert.equal(prefetchUrlAllowed("https://evil.example/1.png", ["https://tiles.example/"]), false);
  assert.equal(prefetchUrlAllowed("https://tiles.example/1.png", ["https://tiles.example/"]), true);

  const cache = offlineTileCache({
    cacheName: "prefix-cache",
    fetcher: undefined,
    urlPrefixes: ["https://tiles.example/"]
  });
  const stats = await cache.prefetch([
    "https://tiles.example/a.png",
    "https://evil.example/b.png",
    "javascript:alert(1)"
  ]);
  assert.equal(stats.queued, 1);
  assert.equal(stats.failed, 2);
});

test("prefetchTileLayer requires bounds and respects maxTiles", async () => {
  const cache = offlineTileCache({ cacheName: "bounded-cache", fetcher: undefined, maxTiles: 8 });
  const layer = {
    getTileSize: () => 256,
    getTileUrl: (x, y, z) => `https://tiles.example/${z}/${x}/${y}.png`
  };

  await assert.rejects(
    () => cache.prefetchTileLayer(layer, { zooms: [2] }),
    /bounds or explicit/
  );

  await assert.rejects(
    () => cache.prefetchTileLayer(layer, {
      bounds: [[-85, -180], [85, 180]],
      zooms: [4],
      maxTiles: 16
    }),
    /maxTiles/
  );

  const stats = await cache.prefetchTileLayer(layer, {
    bounds: [[52.52, 13.40], [52.53, 13.41]],
    zooms: [12],
    xRange: [2476, 2477],
    yRange: [1280, 1281]
  });
  assert.equal(stats.queued, 4);
});

test("VectorTileLayer validates provider and exposes lifecycle container", () => {
  const layer = vectorTileLayer({ provider: () => [] });
  assert.ok(layer instanceof VectorTileLayer);
  assert.equal(layer.tiles.size, 0);
});

test("decodeMVT converts a minimal point tile to GeoJSON", () => {
  const bytes = makeMinimalMVT();
  const features = decodeMVT(bytes, { x: 0, y: 0, z: 0 }, { layer: "places" });
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.name, "Center");
  assert.equal(features[0].geometry.type, "Point");
  assert.ok(Math.abs(features[0].geometry.coordinates[0]) < 1e-9);
  assert.ok(Math.abs(features[0].geometry.coordinates[1]) < 1e-9);
});

test("decodeMVT honors maxBytes and maxFeatures", () => {
  const bytes = makeMinimalMVT();
  assert.equal(decodeMVT(bytes, { x: 0, y: 0, z: 0 }, { maxBytes: 1 }).length, 0);
  assert.equal(decodeMVT(bytes, { x: 0, y: 0, z: 0 }, { layer: "places", maxFeatures: 0 }).length, 0);
});

test("Framework adapter creates, updates and destroys a map", () => {
  const adapter = createMapAdapter(new FakeElement(), { controls: false, center: [1, 2], zoom: 3 });
  adapter.update({ center: [4, 5], zoom: 6, behaviors: { scrollZoom: false } });
  assert.deepEqual(adapter.map.getCenter().toArray(), [4, 5]);
  assert.equal(adapter.map.behaviors.isEnabled("scrollZoom"), false);
  adapter.destroy();
});

test("public stage eight factories remain available", () => {
  assert.ok(webglPointLayer() instanceof WebGLPointLayer);
  assert.ok(offlineTileCache() instanceof OfflineTileCache);
  assert.ok(vectorTileLayer({ provider: () => [] }) instanceof VectorTileLayer);
  assert.equal(typeof decodeMVT, "function");
  assert.equal(typeof createMVTProvider, "function");
  assert.equal(typeof performanceInspector, "function");
  assert.equal(typeof defineOrihonElement, "function");
});

function makeMinimalMVT() {
  const value = message([
    fieldBytes(1, stringBytes("Center"))
  ]);
  const feature = message([
    fieldVarint(1, 7),
    fieldBytes(2, packed([0, 0])),
    fieldVarint(3, 1),
    fieldBytes(4, packed([9, 4096, 4096]))
  ]);
  const layer = message([
    fieldVarint(15, 2),
    fieldBytes(1, stringBytes("places")),
    fieldBytes(2, feature),
    fieldBytes(3, stringBytes("name")),
    fieldBytes(4, value),
    fieldVarint(5, 4096)
  ]);
  return message([fieldBytes(3, layer)]);
}

function message(parts) {
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

function fieldVarint(field, value) {
  return new Uint8Array([...varint((field << 3) | 0), ...varint(value)]);
}

function fieldBytes(field, bytes) {
  return new Uint8Array([...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]);
}

function packed(values) {
  return new Uint8Array(values.flatMap((value) => [...varint(value)]));
}

function stringBytes(value) {
  return new TextEncoder().encode(value);
}

function varint(value) {
  const result = [];
  let next = value;
  while (next > 0x7f) {
    result.push((next & 0x7f) | 0x80);
    next = Math.floor(next / 128);
  }
  result.push(next);
  return result;
}
