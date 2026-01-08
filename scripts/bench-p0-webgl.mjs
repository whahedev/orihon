import { performance } from "node:perf_hooks";
import { Evented } from "../dist/events.js";
import { objectManager } from "../dist/services/object-manager.js";
import { webglPointLayer } from "../dist/layers/webgl-point-layer.js";

const COUNT = Math.max(1, Number.parseInt(process.env.COUNT || "100000", 10));
const FILTER_REPS = Math.max(1, Number.parseInt(process.env.FILTER_REPS || (COUNT >= 1_000_000 ? "3" : "5"), 10));
const PATCH_COUNTS = [1, 100, 1_000, 10_000, 100_000].filter((value) => value <= COUNT);
const gc = typeof globalThis.gc === "function" ? () => globalThis.gc() : () => {};

function formatMs(value) {
  return `${value.toFixed(value < 10 ? 3 : 2)}ms`;
}

function formatBytes(value) {
  const abs = Math.abs(value);
  if (abs < 1024) return `${value} B`;
  if (abs < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function median(values) {
  return percentile(values, 0.5);
}

function repsForPatchCount(count) {
  if (count <= 100) return 9;
  if (count <= 1_000) return 7;
  if (count <= 10_000) return 5;
  return 3;
}

function measure(fn, reps, beforeEach = null) {
  const samples = [];
  for (let i = 0; i < reps; i++) {
    beforeEach?.(i);
    const start = performance.now();
    fn(i);
    samples.push(performance.now() - start);
  }
  return {
    median: median(samples),
    p95: percentile(samples, 0.95),
    min: Math.min(...samples),
    samples
  };
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function coprimeStep(n) {
  if (n <= 2) return 1;
  let step = Math.max(1, Math.floor(n * 0.61803398875));
  while (gcd(step, n) !== 1) step += 1;
  return step;
}

function makeIndices(count, pointCount, mode) {
  const result = new Uint32Array(count);
  if (mode === "sequential") {
    const start = Math.max(0, Math.floor((pointCount - count) / 2));
    for (let i = 0; i < count; i++) result[i] = start + i;
    return result;
  }
  const step = coprimeStep(pointCount);
  const offset = Math.floor(pointCount * 0.17320508075) % pointCount;
  for (let i = 0; i < count; i++) result[i] = (offset + i * step) % pointCount;
  return result;
}

function makeStyleBuffers(count, active) {
  const colors = new Float32Array(count * 4);
  const sizes = new Float32Array(count);
  const rgba = active ? [220 / 255, 38 / 255, 38 / 255, 1] : [37 / 255, 99 / 255, 235 / 255, 1];
  const size = active ? 20 : 8;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    colors[o] = rgba[0];
    colors[o + 1] = rgba[1];
    colors[o + 2] = rgba[2];
    colors[o + 3] = rgba[3];
    sizes[i] = size;
  }
  return { colors, sizes };
}

function makePackedPointData(pointCount) {
  const latlng = new Float32Array(pointCount * 2);
  const merc64 = new Float64Array(pointCount * 2);
  const colors = new Float32Array(pointCount * 4);
  const sizes = new Float32Array(pointCount);
  for (let i = 0; i < pointCount; i++) {
    const row = Math.floor(i / 1000);
    const col = i % 1000;
    const lat = 55 + row * 0.00001;
    const lng = 37 + col * 0.00001;
    const o2 = i * 2;
    const o4 = i * 4;
    latlng[o2] = lat;
    latlng[o2 + 1] = lng;
    merc64[o2] = 0.6027777777777777 + col * 1e-9;
    merc64[o2 + 1] = 0.3160000000000000 + row * 1e-9;
    colors[o4] = 37 / 255;
    colors[o4 + 1] = 99 / 255;
    colors[o4 + 2] = 235 / 255;
    colors[o4 + 3] = 1;
    sizes[i] = 8;
  }
  return { latlng, merc64, colors, sizes };
}

function attachCountingGl(layer) {
  const stats = {
    calls: 0,
    bytes: 0,
    offsets: [],
    reset() {
      this.calls = 0;
      this.bytes = 0;
      this.offsets.length = 0;
    }
  };
  const gl = {
    ARRAY_BUFFER: 0x8892,
    bindBuffer() {},
    bufferSubData(_target, offset, data) {
      stats.calls += 1;
      stats.bytes += data?.byteLength ?? 0;
      if (stats.offsets.length < 16) stats.offsets.push(offset);
    }
  };
  layer.gl = gl;
  layer.colorBuffer = {};
  layer.sizeBuffer = {};
  // TypeScript `private` fields are normal JS properties in dist; matching the
  // already-uploaded byte sizes lets patch methods exercise bufferSubData paths.
  layer._gpuColorBytes = layer.colors.byteLength;
  layer._gpuSizeBytes = layer.sizes.byteLength;
  return stats;
}

function runPatchLayerBench() {
  console.log("\n=== P0 · WebGLPointLayer patchStyles ===");
  console.log(`points: ${COUNT.toLocaleString("en-US")}`);

  const packed = makePackedPointData(COUNT);
  const layer = webglPointLayer([], { pointSize: 8, interactive: false });
  layer.setPackedData(packed.latlng, packed.merc64, {
    colors: packed.colors,
    sizes: packed.sizes,
    adopt: true
  });
  const glStats = attachCountingGl(layer);

  for (const mode of ["sequential", "scattered"]) {
    console.log(`\n${mode}:`);
    console.log("updates | individual color | batch color | speedup | uploads individual→batch | batch bytes");
    for (const count of PATCH_COUNTS) {
      const indices = makeIndices(count, COUNT, mode);
      const a = makeStyleBuffers(count, false);
      const b = makeStyleBuffers(count, true);
      const reps = repsForPatchCount(count);
      let phase = 0;

      const individual = measure(
        () => {
          const rgba = (phase++ & 1) === 0
            ? [37 / 255, 99 / 255, 235 / 255, 1]
            : [220 / 255, 38 / 255, 38 / 255, 1];
          for (let i = 0; i < count; i++) layer.patchColor(indices[i], rgba);
        },
        reps,
        () => glStats.reset()
      );
      glStats.reset();
      const individualRgba = [37 / 255, 99 / 255, 235 / 255, 1];
      for (let i = 0; i < count; i++) layer.patchColor(indices[i], individualRgba);
      const individualCalls = glStats.calls;

      phase = 0;
      const batch = measure(
        () => {
          const style = (phase++ & 1) === 0 ? a : b;
          layer.patchStyles(indices, style.colors, null, count);
        },
        reps,
        () => glStats.reset()
      );
      glStats.reset();
      layer.patchStyles(indices, b.colors, null, count);
      const batchCalls = glStats.calls;
      const batchBytes = glStats.bytes;
      const speedup = individual.median / Math.max(batch.median, 1e-9);

      console.log(
        `${String(count).padStart(7)} | ${formatMs(individual.median).padStart(16)} | ${formatMs(batch.median).padStart(11)} | ${`${speedup.toFixed(1)}x`.padStart(7)} | ${`${individualCalls}→${batchCalls}`.padStart(24)} | ${formatBytes(batchBytes)}`
      );
    }
  }

  const sizePointCount = Math.min(COUNT, 100_000);
  if (sizePointCount >= 1_000) {
    console.log("\nmax-size shrink (pathological case for per-point patchSize):");
    console.log(`size benchmark capped at ${sizePointCount.toLocaleString("en-US")} points to avoid an accidental multi-billion-iteration run.`);
    const latlng = packed.latlng.subarray(0, sizePointCount * 2);
    const merc64 = packed.merc64.subarray(0, sizePointCount * 2);
    const colors = packed.colors.subarray(0, sizePointCount * 4);
    const allMax = new Float32Array(sizePointCount);
    allMax.fill(20);
    layer.setPackedData(latlng, merc64, { colors, sizes: allMax, adopt: false });
    layer._gpuColorBytes = layer.colors.byteLength;
    layer._gpuSizeBytes = layer.sizes.byteLength;

    for (const count of [100, 1_000].filter((value) => value <= sizePointCount)) {
      const indices = makeIndices(count, sizePointCount, "sequential");
      const shrink = new Float32Array(count);
      shrink.fill(8);
      const individualReps = count >= 1_000 ? 1 : 3;

      const individual = measure(
        () => {
          for (let i = 0; i < count; i++) layer.patchSize(indices[i], 8);
        },
        individualReps,
        () => {
          layer.setSizes(allMax);
          layer._gpuSizeBytes = layer.sizes.byteLength;
          glStats.reset();
        }
      );
      const individualCalls = glStats.calls;

      const batch = measure(
        () => layer.patchStyles(indices, null, shrink, count),
        3,
        () => {
          layer.setSizes(allMax);
          layer._gpuSizeBytes = layer.sizes.byteLength;
          glStats.reset();
        }
      );
      const batchCalls = glStats.calls;
      const speedup = individual.median / Math.max(batch.median, 1e-9);
      console.log(
        `${String(count).padStart(5)} updates: individual ${formatMs(individual.median)}, batch ${formatMs(batch.median)}, ${speedup.toFixed(1)}x, uploads ${individualCalls}→${batchCalls}`
      );
    }
  }

  layer.clear();
}

class FakeClassList {
  values = new Set();
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  toggle(name, force) {
    if (force === true) this.values.add(name);
    else if (force === false) this.values.delete(name);
    else if (this.values.has(name)) this.values.delete(name);
    else this.values.add(name);
    return this.values.has(name);
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      getPropertyValue(name) { return this[name] ?? ""; }
    };
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.parent = null;
    if (this.tagName === "CANVAS") {
      this.width = 0;
      this.height = 0;
      this.getContext = () => null;
    }
  }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener() {}
  removeEventListener() {}
  querySelector(selector) {
    const match = (node) => {
      if (selector.startsWith(".") && String(node.className || "").includes(selector.slice(1))) return node;
      for (const child of node.children ?? []) {
        const found = match(child);
        if (found) return found;
      }
      return null;
    };
    return match(this);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

function installDom() {
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    getElementById: () => null
  };
  globalThis.window = globalThis.window || { devicePixelRatio: 1 };
}

function createFakeMap(zoom = 8) {
  installDom();
  class FakeMap extends Evented {
    zoom = zoom;
    layers = new Set();
    size = { width: 1280, height: 720 };
    pixelOrigin = { x: 0, y: 0 };
    container = new FakeElement("div");
    panes = { marker: new FakeElement("div"), overlay: new FakeElement("div") };
    crs = { code: "EPSG:3857" };
    getBounds() { return [[-85, -180], [85, 180]]; }
    getPane(name) { return this.panes[name] || this.panes.overlay; }
    latLngToLayerPoint(value) {
      const lat = Array.isArray(value) ? value[0] : value.lat;
      const lng = Array.isArray(value) ? value[1] : value.lng;
      return { x: lng * 1000, y: -lat * 1000 };
    }
    containerPointToLatLng(value) {
      const x = Array.isArray(value) ? value[0] : value.x;
      const y = Array.isArray(value) ? value[1] : value.y;
      return { lat: -y / 1000, lng: x / 1000 };
    }
    setView() { return this; }
    fitBounds() { return this; }
    addLayer(layer) {
      this.layers.add(layer);
      layer.map = this;
      if (typeof layer.onAdd === "function") {
        try { layer.onAdd(this); } catch { /* no browser WebGL in Node */ }
      }
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      if (typeof layer.onRemove === "function") {
        try { layer.onRemove(); } catch { /* ignore */ }
      }
      layer.map = null;
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }
  return new FakeMap();
}

function addObjectsInChunks(manager, count, chunkSize = 25_000) {
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(count, start + chunkSize);
    const chunk = new Array(end - start);
    for (let i = start; i < end; i++) {
      chunk[i - start] = {
        id: i,
        coordinates: [55 + (i % 1000) * 0.00001, 37 + Math.floor(i / 1000) * 0.00001]
      };
    }
    manager.add(chunk);
  }
}

function addTemporalObjectsInChunks(manager, count, chunkSize = 25_000) {
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(count, start + chunkSize);
    const chunk = new Array(end - start);
    for (let i = start; i < end; i++) {
      chunk[i - start] = {
        id: i,
        coordinates: [55 + (i % 1000) * 0.00001, 37 + Math.floor(i / 1000) * 0.00001],
        properties: { time: i % 10_000 }
      };
    }
    manager.add(chunk);
  }
}

function makeStateUpdates(count, active) {
  const updates = new Array(count);
  for (let i = 0; i < count; i++) updates[i] = { id: i, state: { active } };
  return updates;
}

function memorySnapshot() {
  const value = process.memoryUsage();
  return { heap: value.heapUsed, arrayBuffers: value.arrayBuffers ?? 0, rss: value.rss };
}

function printWebglSyncProfile(manager) {
  const profile = manager._webglSyncProfile;
  if (!profile) {
    console.log("  sync profile: unavailable");
    return;
  }
  console.log(
    `  sync profile: pack ${formatMs(profile.packMs)} ` +
    `(alloc ${formatMs(profile.packAllocateMs ?? 0)}, fill ${formatMs(profile.packFillMs ?? profile.packMs)}), ` +
    `style ${formatMs(profile.styleMs)}, layer ${formatMs(profile.layerMs)}, canonical ${formatMs(profile.canonicalMs)}, ` +
    `total ${formatMs(profile.totalMs)}, zero-copy=${profile.zeroCopyCanonical ? "yes" : "no"}, ` +
    `dense-id-index=${profile.denseIdIndex ? "yes" : "no"}`
  );
}

function runObjectManagerBench() {
  console.log("\n=== P0 · ObjectManager public paths ===");
  const manager = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    sceneFeatures: false,
    styleByCategory: false,
    style: (_object, state) => ({
      color: state.active ? "#dc2626" : "#2563eb",
      opacity: 1,
      size: state.active ? 20 : 8
    })
  });
  const map = createFakeMap(8);

  const ingestStart = performance.now();
  addObjectsInChunks(manager, COUNT);
  const ingestMs = performance.now() - ingestStart;
  const syncStart = performance.now();
  manager.addTo(map);
  const initialSyncMs = performance.now() - syncStart;
  console.log(`ingest ${COUNT.toLocaleString("en-US")}: ${formatMs(ingestMs)}`);
  console.log(`initial WebGL pack/sync (Node, no real GL): ${formatMs(initialSyncMs)}`);
  printWebglSyncProfile(manager);

  console.log("\nsetObjectStates (full ObjectManager path, no real GPU):");
  console.log("updates | median | p95");
  for (const count of PATCH_COUNTS) {
    const off = makeStateUpdates(count, false);
    const on = makeStateUpdates(count, true);
    let phase = 0;
    const reps = repsForPatchCount(count);
    const result = measure(() => {
      manager.setObjectStates((phase++ & 1) === 0 ? on : off);
    }, reps);
    console.log(`${String(count).padStart(7)} | ${formatMs(result.median).padStart(9)} | ${formatMs(result.p95).padStart(9)}`);
  }

  console.log("\nsetFilter / fast WebGL compaction:");
  console.log("visible | median | p95 | array-buffer delta | visible objects");
  for (const ratio of [1, 0.5, 0.1, 0.01]) {
    const threshold = Math.max(1, Math.round(ratio * 10_000));
    const filter = (_object, id) => (id % 10_000) < threshold;
    const samples = [];
    const bufferDeltas = [];
    let visible = 0;
    for (let rep = 0; rep < FILTER_REPS; rep++) {
      manager.setFilter(null);
      gc();
      const before = memorySnapshot();
      const start = performance.now();
      manager.setFilter(filter);
      samples.push(performance.now() - start);
      const after = memorySnapshot();
      bufferDeltas.push(after.arrayBuffers - before.arrayBuffers);
      visible = manager.getStats().visibleObjects;
    }
    manager.setFilter(null);
    console.log(
      `${`${Math.round(ratio * 100)}%`.padStart(7)} | ${formatMs(median(samples)).padStart(9)} | ${formatMs(percentile(samples, 0.95)).padStart(9)} | ${formatBytes(median(bufferDeltas)).padStart(18)} | ${visible.toLocaleString("en-US")}`
    );
  }

  manager.destroy();
}

function runTemporalIndexedBench() {
  console.log("\n=== P1-A/P1-B · indexed temporal filtering ===");
  const manager = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    sceneFeatures: false,
    styleByCategory: false,
    time: { value: (object) => Number(object.properties?.time ?? 0) }
  });
  const map = createFakeMap(8);

  const ingestStart = performance.now();
  addTemporalObjectsInChunks(manager, COUNT);
  const ingestMs = performance.now() - ingestStart;
  const syncStart = performance.now();
  manager.addTo(map);
  const syncMs = performance.now() - syncStart;
  console.log(`temporal ingest ${COUNT.toLocaleString("en-US")}: ${formatMs(ingestMs)}`);
  console.log(`initial temporal WebGL sync: ${formatMs(syncMs)}`);
  printWebglSyncProfile(manager);

  console.log("\ntemporal index only:");
  console.log("visible | median | p95 | mask words | visible objects");
  for (const ratio of [1, 0.5, 0.1, 0.01]) {
    const maxTime = Math.max(0, Math.ceil(ratio * 10_000) - 1);
    const samples = [];
    let visible = 0;
    for (let rep = 0; rep < FILTER_REPS; rep++) {
      manager.setTimeRange(null, null);
      gc();
      const start = performance.now();
      manager.setTimeRange(0, maxTime);
      samples.push(performance.now() - start);
      visible = manager.getStats().visibleObjects;
    }
    const maskWords = manager._webglSystemMask?.length ?? 0;
    console.log(
      `${`${Math.round(ratio * 100)}%`.padStart(7)} | ${formatMs(median(samples)).padStart(9)} | ${formatMs(percentile(samples, 0.95)).padStart(9)} | ${maskWords.toLocaleString("en-US").padStart(10)} | ${visible.toLocaleString("en-US")}`
    );
  }

  let filterCalls = 0;
  const filter = () => {
    filterCalls += 1;
    return true;
  };
  manager.setTimeRange(null, null);
  manager.setFilter(filter);

  console.log("\ntemporal index + arbitrary user filter:");
  console.log("visible | median | p95 | filter calls | visible objects");
  for (const ratio of [1, 0.5, 0.1, 0.01]) {
    const maxTime = Math.max(0, Math.ceil(ratio * 10_000) - 1);
    const samples = [];
    const calls = [];
    let visible = 0;
    for (let rep = 0; rep < FILTER_REPS; rep++) {
      manager.setTimeRange(null, null);
      filterCalls = 0;
      gc();
      const start = performance.now();
      manager.setTimeRange(0, maxTime);
      samples.push(performance.now() - start);
      calls.push(filterCalls);
      visible = manager.getStats().visibleObjects;
    }
    console.log(
      `${`${Math.round(ratio * 100)}%`.padStart(7)} | ${formatMs(median(samples)).padStart(9)} | ${formatMs(percentile(samples, 0.95)).padStart(9)} | ${Math.round(median(calls)).toLocaleString("en-US").padStart(12)} | ${visible.toLocaleString("en-US")}`
    );
  }

  manager.setFilter(null);
  manager.setTimeRange(null, null);
  manager.destroy();
}

console.log(`Orihon P0/P1-A/P1-B/P1-C performance benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`COUNT=${COUNT.toLocaleString("en-US")} · --expose-gc=${typeof globalThis.gc === "function" ? "yes" : "no"}`);
console.log("Note: the low-level patch test uses a counting WebGL stub; ObjectManager runs without a real browser GPU.");

runPatchLayerBench();
gc();
runObjectManagerBench();
gc();
runTemporalIndexedBench();
gc();

console.log("\nDone.");
