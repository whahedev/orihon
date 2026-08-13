import test from "node:test";
import assert from "node:assert/strict";
import { Evented } from "../dist/events.js";
import {
  DivIcon,
  ObjectManager,
  SpatialGridIndex,
  buildClusterIndex,
  buildClusterLayout,
  objectManager,
  queryClusterLayout,
  spatialGridIndex
} from "../dist/index.js";

test("SpatialGridIndex updates cells and searches only matching records", () => {
  const index = spatialGridIndex(0.5);
  index
    .set("berlin", [52.520, 13.405], { city: "Berlin" })
    .set("munich", [48.137, 11.576], { city: "Munich" })
    .set("east", [0, 179], { city: "East" });

  assert.ok(index instanceof SpatialGridIndex);
  assert.equal(index.size, 3);
  assert.deepEqual(
    index.search([[52.3, 13.2], [52.7, 13.6]]).map((record) => record.id),
    ["berlin"]
  );
  assert.deepEqual(
    index.search([[-1, 178], [1, 180]], (record) => record.value.city === "East").map((record) => record.id),
    ["east"]
  );

  index.set("berlin", [50.938, 6.960], { city: "Cologne" });
  assert.equal(index.search([[52.3, 13.2], [52.7, 13.6]]).length, 0);
  assert.deepEqual(index.searchIds([[-1, 178], [1, 180]]), ["east"]);
  assert.equal(index.delete("munich"), true);
  assert.equal(index.size, 2);
});

test("SpatialGridIndex keeps a compact index for a large point set", () => {
  const index = new SpatialGridIndex(0.25);
  for (let i = 0; i < 5000; i++) {
    const lat = 52 + (i % 100) / 100;
    const lng = 13 + (Math.floor(i / 100) % 50) / 50;
    index.set(i, [lat, lng], i);
  }

  assert.equal(index.size, 5000);
  assert.ok(index.cellCount < 30);
  assert.equal(index.search([[52, 13], [52.1, 13.1]]).length, 66);
});

test("ObjectManager maxObjects caps ingest", () => {
  const manager = objectManager({ maxObjects: 2 });
  manager.add([
    { id: 1, coordinates: [52.52, 13.40] },
    { id: 2, coordinates: [52.53, 13.45] },
    { id: 3, coordinates: [52.54, 13.50] }
  ]);
  assert.equal(manager.items.size, 2);
  manager.add({ id: 2, coordinates: [52.55, 13.51] });
  assert.equal(manager.items.size, 2);
  assert.deepEqual(manager.getObject(2)?.coordinates, [52.55, 13.51]);
});

test("ObjectManager exposes indexed collection and filter lifecycle", () => {
  const manager = objectManager({ clusterize: true, clusterGridSize: 64 });
  manager.add([
    { id: 1, coordinates: [52.52, 13.40], properties: { side: "west" } },
    { id: 2, coordinates: [52.53, 13.45], properties: { side: "east" } },
    { id: 3, coordinates: [Number.NaN, 0] }
  ]);

  assert.ok(manager instanceof ObjectManager);
  assert.equal(manager.getStats().objects, 3);
  assert.equal(manager.getStats().indexedObjects, 2);
  assert.equal(manager.getObject(1)?.properties?.side, "west");
  assert.equal(manager.getObjects().length, 3);

  manager.setFilter((item) => item.properties?.side === "west");
  assert.equal(typeof manager.filter, "function");
  manager.setClusterGridSize(50).setClusterize(false);
  assert.equal(manager.options.clusterGridSize, 50);
  assert.equal(manager.options.clusterize, false);

  manager.remove([1, 3]);
  assert.equal(manager.getStats().objects, 1);
  manager.clear();
  assert.equal(manager.getStats().objects, 0);
});


test("ObjectManager exposes object and cluster popup bindings", () => {
  const manager = objectManager();
  assert.equal(manager.bindPopup("object"), manager);
  assert.equal(manager.bindClusterPopup("cluster"), manager);
  assert.equal(manager.closePopup(), manager);
  assert.equal(manager.unbindPopup(), manager);
  assert.equal(manager.unbindClusterPopup(), manager);
});

test("ObjectManager cluster centers stay near source points", () => {
  class FakeMap extends Evented {
    zoom = 10;
    layers = new Set();
    getBounds() {
      return [[52.48, 13.30], [52.55, 13.45]];
    }
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
    addLayer(layer) {
      // Capture markers without mounting DOM; LatLng is set in the Marker constructor.
      this.layers.add(layer);
      layer.map = this;
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      layer.map = null;
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 256,
    clusterMinPoints: 2,
    clusterMaxZoom: 18
  });
  manager.add([
    { id: "a", coordinates: [52.520, 13.405] },
    { id: "b", coordinates: [52.521, 13.406] }
  ]);
  manager.addTo(map);

  assert.equal(manager.clusters.size, 1);
  assert.equal(manager.markers.size, 0);
  const [[, cluster]] = [...manager.clusters];
  const position = cluster.getLatLng();
  assert.ok(Math.abs(position.lat - 52.5205) < 1e-9, `cluster lat ${position.lat}`);
  assert.ok(Math.abs(position.lng - 13.4055) < 1e-9, `cluster lng ${position.lng}`);
  assert.equal(manager.getStats().renderer, "dom");
  assert.equal(manager.getStats().layoutZoom, 10);
});

test("ObjectManager spiderfies at max zoom even when clusterZoomOnClick is disabled", () => {
  class FakeMap extends Evented {
    zoom = 10;
    layers = new Set();
    getBounds() { return [[52.48, 13.30], [52.55, 13.45]]; }
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
    setView() { throw new Error("clusterZoomOnClick=false must not change the view"); }
    addLayer(layer) { this.layers.add(layer); layer.map = this; return this; }
    removeLayer(layer) { this.layers.delete(layer); layer.map = null; return this; }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const manager = objectManager({
    clusterize: true,
    clusterMaxZoom: 10,
    clusterGridSize: 256,
    clusterZoomOnClick: false,
    spiderfyOnMaxZoom: true,
    clusterRenderer: "dom"
  });
  manager.add(Array.from({ length: 12 }, (_, index) => ({
    id: `spider-${index}`,
    coordinates: [52.52 + index * 0.000001, 13.405 + index * 0.000001]
  })));
  let spiderfied = [];
  manager.on("spiderfy", (event) => { spiderfied = event.objectIds; });
  manager.addTo(map);
  assert.equal(manager.clusters.size, 1);

  const cluster = [...manager.clusters.values()][0];
  cluster.emit("click", { latlng: cluster.getLatLng() }, false);
  assert.equal(spiderfied.length, 12);
  assert.equal([...map.layers].filter((layer) => String(layer.options?.className || "").includes("oh-spider-marker")).length, 12);
  manager.destroy();
});

test("ObjectManager webgl renderer uses canvas cluster badges (no DOM Markers)", () => {
  class FakeMap extends Evented {
    zoom = 10;
    layers = new Set();
    getBounds() {
      return [[52.48, 13.30], [52.55, 13.45]];
    }
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
    addLayer(layer) {
      this.layers.add(layer);
      layer.map = this;
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      layer.map = null;
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 256,
    clusterMinPoints: 2,
    clusterMaxZoom: 18,
    clusterRenderer: "webgl",
    layoutWorker: false
  });
  manager.add([
    { id: "a", coordinates: [52.520, 13.405] },
    { id: "b", coordinates: [52.521, 13.406] }
  ]);
  manager.addTo(map);

  assert.equal(manager.getStats().renderer, "webgl");
  assert.equal(manager.clusters.size, 0, "webgl clusters should not mount DOM Markers");
  assert.equal(manager.getStats().clusters, 1);
  assert.equal(manager.getStats().visibleObjects, 2);
  assert.equal(manager.markers.size, 0);
  manager.destroy();
});

test("ObjectManager canvas clusters do not accumulate clusterMembers across zooms", async () => {
  class FakeMap extends Evented {
    zoom = 6;
    layers = new Set();
    getBounds() {
      return [[50, 10], [55, 20]];
    }
    latLngToLayerPoint(value) {
      const lat = Array.isArray(value) ? value[0] : value.lat;
      const lng = Array.isArray(value) ? value[1] : value.lng;
      return { x: lng * 100, y: -lat * 100 };
    }
    containerPointToLatLng(value) {
      const x = Array.isArray(value) ? value[0] : value.x;
      const y = Array.isArray(value) ? value[1] : value.y;
      return { lat: -y / 100, lng: x / 100 };
    }
    setView(_center, zoom) {
      if (zoom != null) this.zoom = zoom;
      return this;
    }
    addLayer(layer) {
      this.layers.add(layer);
      layer.map = this;
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      layer.map = null;
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 80,
    clusterMinPoints: 2,
    clusterMaxZoom: 14,
    clusterRenderer: "webgl",
    layoutWorker: false,
    webglThreshold: 1
  });
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push({ id: `p${i}`, coordinates: [52.5 + (i % 8) * 0.01, 13.4 + Math.floor(i / 8) * 0.01] });
  }
  manager.add(points);
  manager.addTo(map);

  // Force greedy-first path (large enough that hierarchy is deferred in real life;
  // here layoutWorker:false still builds inline under limit — stress zoom keys anyway).
  for (const z of [6, 7, 8, 9, 10, 8, 6]) {
    map.zoom = z;
    manager.render();
  }
  await manager.prepareLayout(8);
  map.zoom = 8;
  manager.render();

  assert.ok(manager.clusterMembers.size <= manager.getStats().clusters + 2,
    `clusterMembers leaked: ${manager.clusterMembers.size} keys vs ${manager.getStats().clusters} clusters`);
  // After hierarchy (expandLeaves:false) members should be empty or only lazily filled.
  assert.ok(manager.clusterMembers.size <= manager.getStats().clusters);
  manager.destroy();
});

test("ObjectManager webgl + custom clusterIcon keeps DOM cluster badges", () => {
  class FakeMap extends Evented {
    zoom = 10;
    layers = new Set();
    getBounds() {
      return [[52.48, 13.30], [52.55, 13.45]];
    }
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
    addLayer(layer) {
      this.layers.add(layer);
      layer.map = this;
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      layer.map = null;
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 256,
    clusterMinPoints: 2,
    clusterMaxZoom: 18,
    clusterRenderer: "webgl",
    layoutWorker: false,
    clusterIcon: (count) => new DivIcon({
      content: String(count),
      className: "oh-cluster-icon oh-cluster-icon--sm custom-cluster",
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    })
  });
  manager.add([
    { id: "a", coordinates: [52.520, 13.405] },
    { id: "b", coordinates: [52.521, 13.406] }
  ]);
  manager.addTo(map);

  assert.equal(manager.getStats().renderer, "webgl");
  assert.equal(manager.clusters.size, 1);
  const [[, cluster]] = [...manager.clusters];
  assert.equal(cluster.options.icon?.options?.content, "2");
  assert.match(String(cluster.options.icon?.options?.className || ""), /custom-cluster/);
  manager.destroy();
});

test("ObjectManager keeps layout across pan at the same zoom", () => {
  class FakeMap extends Evented {
    zoom = 8;
    layers = new Set();
    bounds = [[50, 10], [55, 20]];
    getBounds() { return this.bounds; }
    latLngToLayerPoint(value) {
      const lat = Array.isArray(value) ? value[0] : value.lat;
      const lng = Array.isArray(value) ? value[1] : value.lng;
      return { x: lng * 100, y: -lat * 100 };
    }
    containerPointToLatLng(value) {
      const x = Array.isArray(value) ? value[0] : value.x;
      const y = Array.isArray(value) ? value[1] : value.y;
      return { lat: -y / 100, lng: x / 100 };
    }
    setView() { return this; }
    addLayer(layer) {
      this.layers.add(layer);
      layer.map = this;
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      layer.map = null;
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 64,
    clusterMinPoints: 2,
    clusterRenderer: "dom"
  });
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push({ id: i, coordinates: [52.5 + i * 0.001, 13.4 + i * 0.001] });
  }
  manager.add(points);
  manager.addTo(map);
  const firstZoom = manager.getStats().layoutZoom;
  const firstClusters = manager.clusters.size;
  const firstMarkers = [...manager.clusters.values()];
  map.bounds = [[51, 11], [54, 18]];
  manager.render();
  assert.equal(manager.getStats().layoutZoom, firstZoom);
  assert.equal(manager.clusters.size, firstClusters);
  assert.deepEqual([...manager.clusters.values()], firstMarkers);
  manager.destroy();
});

test("ObjectManager reuses pooled cluster badges across zoom rebuilds", () => {
  class FakeMap extends Evented {
    zoom = 8;
    layers = new Set();
    getBounds() {
      return [[50, 10], [55, 20]];
    }
    latLngToLayerPoint(value) {
      const lat = Array.isArray(value) ? value[0] : value.lat;
      const lng = Array.isArray(value) ? value[1] : value.lng;
      return { x: lng * 100, y: -lat * 100 };
    }
    containerPointToLatLng(value) {
      const x = Array.isArray(value) ? value[0] : value.x;
      const y = Array.isArray(value) ? value[1] : value.y;
      return { lat: -y / 100, lng: x / 100 };
    }
    setView() { return this; }
    addLayer(layer) {
      this.layers.add(layer);
      layer.map = this;
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      layer.map = null;
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 64,
    clusterMinPoints: 2,
    clusterRenderer: "dom",
    layoutWorker: false
  });
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push({ id: i, coordinates: [52.5 + i * 0.001, 13.4 + i * 0.001] });
  }
  manager.add(points);
  manager.addTo(map);
  const before = manager.clusters.size;
  assert.ok(before > 0);
  map.zoom = 9;
  manager.render();
  assert.ok(manager.clusters.size > 0);
  map.zoom = 8;
  manager.render();
  assert.equal(manager.clusters.size, before);
  manager.destroy();
});

test("buildClusterLayout clusters nearby points within radius", () => {
  const result = buildClusterLayout({
    ids: ["a", "b", "c"],
    coords: new Float64Array([52.52, 13.405, 52.521, 13.406, 60, 30]),
    zoomBucket: 10,
    gridSize: 256,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 18
  });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].ids.length, 2);
  assert.equal(result.singles.length, 1);
  assert.equal(result.singles[0].id, "c");
});

test("buildClusterLayout keeps points beyond radius separate", () => {
  const far = buildClusterLayout({
    ids: ["a", "b"],
    coords: new Float64Array([52.52, 13.405, 52.53, 13.42]),
    zoomBucket: 12,
    gridSize: 20,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 18
  });
  assert.equal(far.clusters.length, 0);
  assert.equal(far.singles.length, 2);

  const near = buildClusterLayout({
    ids: ["a", "b"],
    coords: new Float64Array([52.52, 13.405, 52.5201, 13.4051]),
    zoomBucket: 12,
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 18
  });
  assert.equal(near.clusters.length, 1);
  assert.equal(near.clusters[0].ids.length, 2);
});

test("hierarchical clustering shows more clusters at higher zoom", () => {
  const ids = [];
  const coords = [];
  for (let i = 0; i < 40; i++) {
    ids.push(i);
    coords.push(52.5 + (i % 8) * 0.002, 13.4 + Math.floor(i / 8) * 0.002);
  }
  const index = buildClusterIndex({
    ids,
    coords: new Float64Array(coords),
    gridSize: 50,
    minPoints: 2,
    clusterize: true,
    clusterMaxZoom: 14,
    clusterMinZoom: 8
  });
  const high = queryClusterLayout(index, 14);
  const low = queryClusterLayout(index, 8);
  const highNodes = high.clusters.length + high.singles.length;
  const lowNodes = low.clusters.length + low.singles.length;
  assert.ok(highNodes > lowNodes, `expected more nodes at z14 (${highNodes}) than z8 (${lowNodes})`);
});


test("ObjectManager.prepareLayout builds clusters off the hot path", async () => {
  class FakeMap extends Evented {
    zoom = 10;
    layers = new Set();
    getBounds() {
      return [[52.48, 13.30], [52.55, 13.45]];
    }
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
    addLayer(layer) {
      this.layers.add(layer);
      layer.map = this;
      return this;
    }
    removeLayer(layer) {
      this.layers.delete(layer);
      layer.map = null;
      return this;
    }
    addAttribution() { return this; }
    removeAttribution() { return this; }
  }

  const map = new FakeMap();
  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 256,
    clusterMinPoints: 2,
    clusterMaxZoom: 18,
    clusterRenderer: "dom",
    layoutWorker: false
  });
  manager.add([
    { id: "a", coordinates: [52.520, 13.405] },
    { id: "b", coordinates: [52.521, 13.406] }
  ]);
  await manager.prepareLayout(10);
  manager.addTo(map);
  assert.equal(manager.clusters.size, 1);
  assert.equal(manager.getStats().layoutZoom, 10);
  manager.destroy();
});
