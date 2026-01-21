import test from "node:test";
import assert from "node:assert/strict";
import { Evented } from "../dist/events.js";
import { clusterLayoutWorkerSource, encodeClusterIndex, decodeClusterIndex } from "../dist/services/cluster-layout.js";
import { getSharedGeometryWorkerPool } from "../dist/services/geometry-worker.js";
import {
  OfflineTileCache,
  PerformanceInspector,
  VectorTileLayer,
  WebGLPointLayer,
  MarkerCollection,
  GeometryWorkerError,
  buildClusterIndex,
  createMVTProvider,
  createMapAdapter,
  createGeometryWorkerPool,
  decodeMVT,
  defineOrihonElement,
  geometryWorkerPool,
  objectManager,
  offlineTileCache,
  performanceInspector,
  preparePointBatch,
  queryClusterLayout,
  vectorTileLayer,
  webglPointLayer
} from "../dist/index.js";
import { decodePackedMVT, packedToGeoJSON } from "orihon/mvt";
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
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.attributes = new Map();
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.width = 0;
    this.height = 0;
  }
  appendChild(child) {
    if (child.parent && child.parent !== this) {
      child.parent.children = child.parent.children.filter((entry) => entry !== child);
    }
    this.children.push(child);
    child.parent = this;
    return child;
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
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
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  getElementById: () => null
};
globalThis.window = new FakeElement();
globalThis.requestAnimationFrame = (callback) => {
  callback?.(16);
  return 1;
};
globalThis.cancelAnimationFrame = () => {};

test("MarkerCollection auto picks webgl above threshold", () => {
  class FakeMap extends Evented {
    zoom = 10;
    size = { width: 800, height: 600 };
    pixelOrigin = { x: 0, y: 0 };
    panes = { overlay: new FakeElement(), marker: new FakeElement() };
    layers = new Set();
    bounds = [[40, 0], [70, 30]];
    getZoom() { return this.zoom; }
    getSize() { return { x: 800, y: 600 }; }
    getBounds() { return this.bounds; }
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

  const small = objectManager({ points, renderer: "auto", webglThreshold: 100 });
  assert.ok(small instanceof MarkerCollection);
  assert.equal(small.size, 30);

  const map = new FakeMap();
  small.addTo(map);
  assert.equal(small.renderer, "dom");
  assert.equal(map.layers.size, 1, "internal DOM markers must not become map layers");
  assert.equal(map.panes.marker.children.length, 1);
  const collectionPane = map.panes.marker.children[0];
  assert.equal(collectionPane.children.length, 30);
  assert.equal(collectionPane.children[0].style.pointerEvents, "none");
  assert.equal(collectionPane.children[0].children.length, 0, "non-interactive dots use the one-node fast path");
  assert.equal(collectionPane.children[0].getAttribute("aria-hidden"), "true");
  const mounted = [...collectionPane.children];
  map.bounds = [[-1, -1], [1, 1]];
  small.redraw();
  assert.equal(collectionPane.children.length, 30, "culled markers stay in the bounded recycle pool");
  map.bounds = [[40, 0], [70, 30]];
  small.redraw();
  assert.deepEqual(collectionPane.children, mounted, "viewport return reuses existing DOM nodes");
  small.remove();

  const hybrid = objectManager({ points, renderer: "hybrid", domLimit: 10 });
  hybrid.addTo(map);
  assert.equal(hybrid.renderer, "hybrid");
  assert.equal(map.panes.marker.children[0].children.length, 10, "hybrid caps live DOM markers");
  assert.equal(map.layers.size, 2, "hybrid owns one collection plus one WebGL remainder");
  hybrid.remove();

  const svgDom = objectManager({ points,
    renderer: "svg",
    htmlButtonLimit: 5,
    marker: { interactive: true, keyboard: true, title: "Open object" }
  });
  svgDom.addTo(map);
  assert.equal(svgDom.renderer, "svg");
  const buttonRoot = map.panes.marker.children.find((child) => child.tagName === "div");
  const svg = buttonRoot.children.find((child) => child.tagName === "svg");
  assert.ok(svg, "SVG DOM renderer mounts one shared root");
  const group = svg.children.find((child) => child.tagName === "g");
  assert.equal(group.children.length, 29, "dense points share one automatic HTML-button cell");
  assert.equal(group.children[0].tagName, "circle");
  assert.equal(buttonRoot.children.filter((child) => child.tagName === "button").length, 1, "automatic buttons are spatially thinned");
  svgDom.setSelected([0, 1, 2, 3, 4, 5]);
  assert.equal(buttonRoot.children.filter((child) => child.tagName === "button").length, 6, "selected objects override the soft button budget");
  assert.equal(group.children.length, 24);
  assert.equal(svgDom.getElement(0).tagName, "button");
  assert.equal(svgDom.getElement(0).style.pointerEvents, "auto", "promoted buttons remain interactive");
  assert.equal(svgDom.getElement(0).tabIndex, 0, "promoted buttons remain keyboard reachable");
  svgDom.setPointSelected(5, false);
  assert.equal(svgDom.getElement(5).tagName, "circle", "deselected points return to the lightweight SVG set");
  map.pixelOrigin = { x: 24, y: 12 };
  svgDom.render();
  assert.notEqual(buttonRoot.style.transform, "", "camera motion warps the shared HTML/SVG root");
  assert.equal(svg.style.transform ?? "", "", "nested SVG does not trigger a separate rasterizing transform");
  svgDom.redraw();
  assert.equal(buttonRoot.style.transform, "", "settled button positions clear the temporary warp");
  svgDom.remove();

  const largePts = [];
  for (let i = 0; i < 120; i++) largePts.push([52 + (i % 10) * 0.1, 13 + Math.floor(i / 10) * 0.1]);
  const large = objectManager({ points: largePts, renderer: "auto", webglThreshold: 50 });
  large.addTo(map);
  assert.equal(large.renderer, "webgl");

  // Icon LOD: high zoom forces DOM markers even above the WebGL threshold.
  const lod = objectManager({ points: largePts,
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

test("MarkerCollection points prefer fill vocabulary over color aliases", () => {
  const collection = objectManager({
    points: [[55.75, 37.61]],
    renderer: "svg",
    fill: "#2563eb",
    fillOpacity: 0.4,
    color: "#dc2626",
    opacity: 0.9
  });
  assert.ok(collection instanceof MarkerCollection);
  assert.equal(collection.options.fill, "#2563eb");
  assert.equal(collection.options.color, "#2563eb");
  assert.equal(collection.options.fillOpacity, 0.4);
  assert.equal(collection.options.opacity, 0.4);
  collection.remove();
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

test("WebGLPointLayer setDataAsync projects chunks and adopts packed buffers", async () => {
  const layer = webglPointLayer([], { interactive: false });
  const progress = [];
  const returned = await layer.setDataAsync([
    [52.52, 13.405],
    { coordinates: [52.53, 13.41] },
    { lat: Number.NaN, lng: 1 }
  ], {
    chunkSize: 2,
    yieldMode: "task",
    onProgress: (processed, total) => progress.push([processed, total])
  });
  assert.equal(returned, layer);
  assert.equal(layer.getStats().points, 2);
  assert.equal(layer.getLatLngBuf().length, 4);
  assert.deepEqual(progress, [[2, 3], [3, 3]]);
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

test("WebGLPointLayer skips pick-index when not interactive and can adopt packed buffers", () => {
  const latlng = new Float32Array([52.5, 13.4, 52.51, 13.41]);
  const merc64 = new Float64Array([0.5, 0.4, 0.51, 0.41]);
  const layer = webglPointLayer([], { interactive: false });
  layer.setPackedData(latlng, merc64, { adopt: true });
  assert.equal(layer.getStats().points, 2);
  assert.equal(layer.getStats().pickIndex, 0);
  assert.equal(layer.getLatLngBuf().buffer, latlng.buffer);
  layer.setInteractive(true);
  assert.equal(layer.getStats().pickIndex, 2);
  layer.setInteractive(false);
  assert.equal(layer.getStats().pickIndex, 0);
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
  const progress = [];
  const prepared = await pool.preparePoints([[5, 6], [7, 8], [9, 10]], {
    chunkSize: 2,
    yieldMode: "task",
    onProgress: (processed, total) => progress.push([processed, total])
  });
  assert.equal(prepared.count, 3);
  assert.deepEqual(progress, [[2, 3], [3, 3]]);
  pool.destroy();
});

test("geometry worker pool factories return caller-owned instances", () => {
  const first = createGeometryWorkerPool({ useWorker: false });
  const second = createGeometryWorkerPool({ useWorker: false });
  const deprecatedFirst = geometryWorkerPool({ useWorker: false });
  const deprecatedSecond = geometryWorkerPool({ useWorker: false });

  assert.notEqual(first, second);
  assert.notEqual(deprecatedFirst, deprecatedSecond);

  first.destroy();
  second.destroy();
  deprecatedFirst.destroy();
  deprecatedSecond.destroy();
});

test("destroying an owned geometry pool does not affect the library shared pool", async () => {
  const shared = getSharedGeometryWorkerPool();
  const owned = createGeometryWorkerPool({ useWorker: false });
  assert.notEqual(owned, shared);

  owned.destroy();

  const prepared = await shared.preparePoints([[1, 2]]);
  assert.equal(prepared.count, 1);
});

test("GeometryWorkerPool.destroy is terminal and idempotent", async () => {
  const pool = createGeometryWorkerPool({ useWorker: false });
  const layoutRequest = {
    ids: [1],
    coords: new Float64Array([1, 2]),
    zoomBucket: 1,
    gridSize: 256,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 18
  };
  pool.destroy();
  pool.destroy();

  await assert.rejects(pool.preparePoints([[1, 2]]), { name: "AbortError" });
  await assert.rejects(pool.clusterLayout(layoutRequest), { name: "AbortError" });
  await assert.rejects(pool.greedyClusterLayout(layoutRequest), { name: "AbortError" });
  await assert.rejects(pool.clusterIndex(layoutRequest), { name: "AbortError" });
});

test("GeometryWorkerPool.destroy rejects pending worker work with AbortError", async () => {
  const originalWorker = globalThis.Worker;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let workerInstance;

  class FakeWorker {
    onmessage = null;
    terminated = false;
    constructor() { workerInstance = this; }
    postMessage() {}
    terminate() { this.terminated = true; }
  }

  globalThis.Worker = FakeWorker;
  URL.createObjectURL = () => "blob:geometry-worker-test";
  URL.revokeObjectURL = () => {};

  try {
    const pool = createGeometryWorkerPool();
    const operation = pool.preparePoints([[1, 2]]);
    await Promise.resolve();
    assert.equal(pool.pending.size, 1);

    pool.destroy();

    await assert.rejects(operation, { name: "AbortError" });
    assert.equal(workerInstance.terminated, true);
    assert.equal(pool.pending.size, 0);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("GeometryWorkerPool rejects all pending work on worker failure and can recover", async () => {
  const originalWorker = globalThis.Worker;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const workers = [];

  class FakeWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    messages = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }

  globalThis.Worker = FakeWorker;
  URL.createObjectURL = () => `blob:geometry-worker-${workers.length}`;
  URL.revokeObjectURL = () => {};

  try {
    const pool = createGeometryWorkerPool();
    const first = pool.preparePoints([[1, 2]]);
    const second = pool.preparePoints([[3, 4]]);
    const cause = new Error("worker crashed");
    const firstRejected = assert.rejects(first, (error) =>
      error instanceof GeometryWorkerError && error.cause === cause && /worker crashed/.test(error.message)
    );
    const secondRejected = assert.rejects(second, { name: "GeometryWorkerError" });
    await Promise.resolve();
    assert.equal(pool.pending.size, 2);

    let prevented = false;
    workers[0].onerror({
      message: "worker crashed",
      error: cause,
      preventDefault() { prevented = true; }
    });

    await Promise.all([firstRejected, secondRejected]);
    assert.equal(prevented, true);
    assert.equal(workers[0].terminated, true);
    assert.equal(pool.pending.size, 0);

    const recovered = pool.preparePoints([[5, 6]]);
    await Promise.resolve();
    assert.equal(workers.length, 2);
    workers[0].onerror({
      message: "late stale worker error",
      error: new Error("late stale worker error"),
      preventDefault() {}
    });
    assert.equal(pool.pending.size, 1);
    assert.equal(workers[1].terminated, false);
    const request = workers[1].messages[0];
    workers[1].onmessage({
      data: {
        id: request.id,
        type: "preparePoints",
        points: new Float32Array([5, 6]).buffer,
        count: 1,
        skipped: 0
      }
    });
    assert.equal((await recovered).count, 1);
    pool.destroy();
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("GeometryWorkerPool rejects pending work on message deserialization failure", async () => {
  const originalWorker = globalThis.Worker;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let workerInstance;

  class FakeWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    constructor() { workerInstance = this; }
    postMessage() {}
    terminate() {}
  }

  globalThis.Worker = FakeWorker;
  URL.createObjectURL = () => "blob:geometry-worker-messageerror";
  URL.revokeObjectURL = () => {};

  try {
    const pool = createGeometryWorkerPool();
    const operation = pool.preparePoints([[1, 2]]);
    const rejected = assert.rejects(operation, (error) =>
      error?.name === "GeometryWorkerError" && /unreadable message/.test(error.message)
    );
    await Promise.resolve();
    workerInstance.onmessageerror({ data: null });
    await rejected;
    assert.equal(pool.pending.size, 0);
    pool.destroy();
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("GeometryWorkerPool rejects a request when postMessage throws", async () => {
  const originalWorker = globalThis.Worker;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const cause = new Error("cannot clone input");

  class FakeWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    postMessage() { throw cause; }
    terminate() {}
  }

  globalThis.Worker = FakeWorker;
  URL.createObjectURL = () => "blob:geometry-worker-post-error";
  URL.revokeObjectURL = () => {};

  try {
    const pool = createGeometryWorkerPool();
    const operation = pool.preparePoints([[1, 2]]);
    await assert.rejects(operation, (error) =>
      error?.name === "GeometryWorkerError" && error.cause === cause && /Failed to send/.test(error.message)
    );
    assert.equal(pool.pending.size, 0);
    pool.destroy();
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("GeometryWorkerPool rejects an unexpected worker response", async () => {
  const originalWorker = globalThis.Worker;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let workerInstance;
  let request;

  class FakeWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    constructor() { workerInstance = this; }
    postMessage(message) { request = message; }
    terminate() {}
  }

  globalThis.Worker = FakeWorker;
  URL.createObjectURL = () => "blob:geometry-worker-unexpected-response";
  URL.revokeObjectURL = () => {};

  try {
    const pool = createGeometryWorkerPool();
    const operation = pool.preparePoints([[1, 2]]);
    const rejected = assert.rejects(operation, (error) =>
      error?.name === "GeometryWorkerError" && /unexpectedResult/.test(error.message)
    );
    await Promise.resolve();
    workerInstance.onmessage({ data: { id: request.id, type: "unexpectedResult" } });
    await rejected;
    assert.equal(pool.pending.size, 0);
    pool.destroy();
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
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

test("GeometryWorkerPool.greedyClusterLayout preserves caller ids", async () => {
  const request = {
    ids: ["near-a", "near-b", "far"],
    coords: new Float64Array([52.52, 13.405, 52.521, 13.406, 60, 30]),
    zoomBucket: 10,
    gridSize: 256,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 18
  };
  const pool = geometryWorkerPool({ useWorker: false });
  const result = await pool.greedyClusterLayout(request);
  assert.equal(result.clusters.length, 1);
  assert.deepEqual(new Set(result.clusters[0].ids), new Set(["near-a", "near-b"]));
  assert.equal(result.singles[0].id, "far");
  pool.destroy();
});

test("cluster worker source is valid JavaScript", () => {
  const source = clusterLayoutWorkerSource();
  assert.match(source, /buildClusterIndex/);
  assert.match(source, /greedyClusterLayout/);
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

test("cluster index encode omits ids so the worker does not clone them", () => {
  const ids = [10, 20, 30];
  const index = buildClusterIndex({
    ids,
    coords: new Float64Array([52.52, 13.405, 52.521, 13.406, 60, 30]),
    gridSize: 256,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 18
  });
  const encoded = encodeClusterIndex(index);
  assert.equal(encoded.payload.ids, undefined);
  const decoded = decodeClusterIndex(encoded.payload);
  decoded.ids = ids;
  const syncLayout = queryClusterLayout(index, 10, 2, { expandLeaves: false });
  const roundTrip = queryClusterLayout(decoded, 10, 2, { expandLeaves: false });
  assert.equal(roundTrip.clusters.length, syncLayout.clusters.length);
  assert.equal(roundTrip.singles.length, syncLayout.singles.length);
});

test("queryClusterLayout leafMask filters leaves without rebuilding the index", () => {
  const ids = [1, 2, 3, 4];
  const index = buildClusterIndex({
    ids,
    coords: new Float64Array([52.52, 13.405, 52.5201, 13.4051, 52.5202, 13.4052, 60, 30]),
    gridSize: 80,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 14
  });
  const all = queryClusterLayout(index, 10, 2, { expandLeaves: false });
  const mask = Uint8Array.from([1, 0, 1, 1]);
  const filtered = queryClusterLayout(index, 10, 2, { expandLeaves: false, leafMask: mask });
  const total = (layout) =>
    layout.clusters.reduce((n, cluster) => n + (cluster.count || 0), 0) + layout.singles.length;
  assert.ok(total(filtered) < total(all));
  assert.equal(filtered.singles.some((single) => single.id === 2), false);
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
  assert.equal(prefetchUrlAllowed("https://tiles.example.evil/1.png", ["https://tiles.example/"]), false);
  assert.equal(prefetchUrlAllowed("\njava\tscript:alert(1)"), false);
  assert.equal(prefetchUrlAllowed("ftp://tiles.example/1.png"), false);

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

test("OfflineTileCache bounds prefetch concurrency", async () => {
  const originalCaches = globalThis.caches;
  let active = 0;
  let peak = 0;
  let puts = 0;
  globalThis.caches = {
    async open() {
      return {
        async put() { puts++; },
        async match() { return undefined; }
      };
    }
  };
  try {
    const cache = offlineTileCache({
      concurrency: 3,
      fetcher: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return new Response("tile");
      }
    });
    const stats = await cache.prefetch(Array.from({ length: 12 }, (_, i) => `/tile-${i}.png`));
    assert.equal(peak, 3);
    assert.equal(puts, 12);
    assert.equal(stats.cached, 12);
  } finally {
    globalThis.caches = originalCaches;
  }
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

test("decodePackedMVT keeps tile-local vertices before GeoJSON conversion", () => {
  const bytes = makeMinimalMVT();
  const packed = decodePackedMVT(bytes, { x: 0, y: 0, z: 0 }, { layer: "places" });
  assert.equal(packed.layers.length, 1);
  assert.equal(packed.layers[0].types.length, 1);
  assert.equal(packed.layers[0].types[0], 1);
  assert.equal(packed.layers[0].xy[0], 2048);
  assert.equal(packed.layers[0].xy[1], 2048);
  const features = packedToGeoJSON(packed);
  assert.equal(features[0].geometry.type, "Point");
  assert.ok(Math.abs(features[0].geometry.coordinates[0]) < 1e-9);
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
  assert.equal(typeof decodePackedMVT, "function");
  assert.equal(typeof packedToGeoJSON, "function");
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
