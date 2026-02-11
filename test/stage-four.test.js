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
    .set("berlin", { lat: 52.520, lng: 13.405 }, { city: "Berlin" })
    .set("munich", { lat: 48.137, lng: 11.576 }, { city: "Munich" })
    .set("east", { lat: 0, lng: 179 }, { city: "East" });

  assert.ok(index instanceof SpatialGridIndex);
  assert.equal(index.size, 3);
  assert.deepEqual(
    index.search([{ lat: 52.3, lng: 13.2 }, { lat: 52.7, lng: 13.6 }]).map((record) => record.id),
    ["berlin"]
  );
  assert.deepEqual(
    index.search([{ lat: -1, lng: 178 }, { lat: 1, lng: 180 }], (record) => record.value.city === "East").map((record) => record.id),
    ["east"]
  );

  index.set("berlin", { lat: 50.938, lng: 6.960 }, { city: "Cologne" });
  assert.equal(index.search([{ lat: 52.3, lng: 13.2 }, { lat: 52.7, lng: 13.6 }]).length, 0);
  assert.deepEqual(index.searchIds([{ lat: -1, lng: 178 }, { lat: 1, lng: 180 }]), ["east"]);
  assert.equal(index.delete("munich"), true);
  assert.equal(index.size, 2);
});

test("SpatialGridIndex same-cell moves keep the record object", () => {
  const index = spatialGridIndex(1);
  index.set("berlin", { lat: 52.52, lng: 13.4 }, { n: 1 });
  const first = index.records.get("berlin");
  index.set("berlin", { lat: 52.6, lng: 13.5 }, { n: 2 });
  const second = index.records.get("berlin");
  assert.equal(first, second);
  assert.equal(second?.value.n, 2);
  assert.equal(index.cellCount, 1);
  assert.deepEqual(index.searchIds([{ lat: 52.4, lng: 13.3 }, { lat: 52.8, lng: 13.7 }]), ["berlin"]);
});

test("SpatialGridIndex keeps a compact index for a large point set", () => {
  const index = new SpatialGridIndex(0.25);
  for (let i = 0; i < 5000; i++) {
    const lat = 52 + (i % 100) / 100;
    const lng = 13 + (Math.floor(i / 100) % 50) / 50;
    index.set(i, { lat: lat, lng: lng }, i);
  }

  assert.equal(index.size, 5000);
  assert.ok(index.cellCount < 30);
  assert.equal(index.search([{ lat: 52, lng: 13 }, { lat: 52.1, lng: 13.1 }]).length, 66);
});

test("ObjectManager maxObjects caps ingest", () => {
  const manager = objectManager({ maxObjects: 2 });
  manager.add([
    { id: 1, coordinates: { lat: 52.52, lng: 13.40 } },
    { id: 2, coordinates: { lat: 52.53, lng: 13.45 } },
    { id: 3, coordinates: { lat: 52.54, lng: 13.50 } }
  ]);
  assert.equal(manager.items.size, 2);
  manager.add({ id: 2, coordinates: { lat: 52.55, lng: 13.51 } });
  assert.equal(manager.items.size, 2);
  assert.deepEqual(manager.getObject(2)?.coordinates, { lat: 52.55, lng: 13.51 });
});

test("ObjectManager addAsync chunks iterable ingest and flushes bulk state", async () => {
  const manager = objectManager({ clusterize: false, sceneFeatures: false });
  function* objects() {
    for (let index = 0; index < 5; index++) {
      yield { id: index, coordinates: ({ lat: 52 + index, lng: 13 }), properties: {} };
    }
  }
  const progress = [];
  const returned = await manager.addAsync(objects(), {
    chunkSize: 2,
    yieldMode: "task",
    render: false,
    onProgress: (processed, total) => progress.push([processed, total])
  });
  assert.equal(returned, manager);
  assert.equal(manager.getStats().objects, 5);
  assert.deepEqual(progress, [[2, null], [4, null], [5, null]]);
});

test("ObjectManager exposes indexed collection and filter lifecycle", () => {
  const manager = objectManager({ clusterize: true, clusterRadiusPixels: 64 });
  manager.add([
    { id: 1, coordinates: { lat: 52.52, lng: 13.40 }, properties: { side: "west" } },
    { id: 2, coordinates: { lat: 52.53, lng: 13.45 }, properties: { side: "east" } },
    { id: 3, coordinates: { lat: Number.NaN, lng: 0 } }
  ]);

  assert.ok(manager instanceof ObjectManager);
  assert.equal(manager.getStats().objects, 3);
  assert.equal(manager.getStats().indexedObjects, 2);
  assert.equal(manager.getObject(1)?.properties?.side, "west");
  assert.equal(manager.getObjects().length, 3);

  manager.setFilter((item) => item.properties?.side === "west");
  assert.equal(typeof manager.filter, "function");
  manager.setClusterRadiusPixels(50).setClusterize(false);
  assert.equal(manager.options.clusterRadiusPixels, 50);
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
      return [({ lat: 52.48, lng: 13.30 }), ({ lat: 52.55, lng: 13.45 })];
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
    clusterRadiusPixels: 256,
    clusterMinPoints: 2,
    clusterMaxZoom: 18
  });
  manager.add([
    { id: "a", coordinates: { lat: 52.520, lng: 13.405 } },
    { id: "b", coordinates: { lat: 52.521, lng: 13.406 } }
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
    getBounds() { return [({ lat: 52.48, lng: 13.30 }), ({ lat: 52.55, lng: 13.45 })]; }
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
    clusterRadiusPixels: 256,
    clusterZoomOnClick: false,
    spiderfyOnMaxZoom: true,
    clusterRenderer: "dom"
  });
  manager.add(Array.from({ length: 12 }, (_, index) => ({
    id: `spider-${index}`,
    coordinates: ({ lat: 52.52 + index * 0.000001, lng: 13.405 + index * 0.000001 })
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
      return [({ lat: 52.48, lng: 13.30 }), ({ lat: 52.55, lng: 13.45 })];
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
    clusterRadiusPixels: 256,
    clusterMinPoints: 2,
    clusterMaxZoom: 18,
    clusterRenderer: "webgl",
    layoutWorker: false
  });
  manager.add([
    { id: "a", coordinates: { lat: 52.520, lng: 13.405 } },
    { id: "b", coordinates: { lat: 52.521, lng: 13.406 } }
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
      return [({ lat: 50, lng: 10 }), ({ lat: 55, lng: 20 })];
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
    clusterRadiusPixels: 80,
    clusterMinPoints: 2,
    clusterMaxZoom: 14,
    clusterRenderer: "webgl",
    layoutWorker: false,
    webglThreshold: 1
  });
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push({ id: `p${i}`, coordinates: ({ lat: 52.5 + (i % 8) * 0.01, lng: 13.4 + Math.floor(i / 8) * 0.01 }) });
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
      return [({ lat: 52.48, lng: 13.30 }), ({ lat: 52.55, lng: 13.45 })];
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
    clusterRadiusPixels: 256,
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
    { id: "a", coordinates: { lat: 52.520, lng: 13.405 } },
    { id: "b", coordinates: { lat: 52.521, lng: 13.406 } }
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
    bounds = [{ lat: 50, lng: 10 }, { lat: 55, lng: 20 }];
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
    clusterRadiusPixels: 64,
    clusterMinPoints: 2,
    clusterRenderer: "dom"
  });
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push({ id: i, coordinates: ({ lat: 52.5 + i * 0.001, lng: 13.4 + i * 0.001 }) });
  }
  manager.add(points);
  manager.addTo(map);
  const firstZoom = manager.getStats().layoutZoom;
  const firstClusters = manager.clusters.size;
  const firstMarkers = [...manager.clusters.values()];
  map.bounds = [{ lat: 51, lng: 11 }, { lat: 54, lng: 18 }];
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
      return [({ lat: 50, lng: 10 }), ({ lat: 55, lng: 20 })];
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
    clusterRadiusPixels: 64,
    clusterMinPoints: 2,
    clusterRenderer: "dom",
    layoutWorker: false
  });
  const points = [];
  for (let i = 0; i < 40; i++) {
    points.push({ id: i, coordinates: ({ lat: 52.5 + i * 0.001, lng: 13.4 + i * 0.001 }) });
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
      return [({ lat: 52.48, lng: 13.30 }), ({ lat: 52.55, lng: 13.45 })];
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
    clusterRadiusPixels: 256,
    clusterMinPoints: 2,
    clusterMaxZoom: 18,
    clusterRenderer: "dom",
    layoutWorker: false
  });
  manager.add([
    { id: "a", coordinates: { lat: 52.520, lng: 13.405 } },
    { id: "b", coordinates: { lat: 52.521, lng: 13.406 } }
  ]);
  await manager.prepareLayout(10);
  manager.addTo(map);
  assert.equal(manager.clusters.size, 1);
  assert.equal(manager.getStats().layoutZoom, 10);
  manager.destroy();
});

test("ObjectManager caps the all-zoom hierarchy for mass clustering", async () => {
  const manager = objectManager({
    clusterize: true,
    clusterRadiusPixels: 256,
    clusterMaxZoom: 18,
    clusterHierarchyMaxObjects: 2,
    layoutWorker: false
  });
  manager.add([
    { id: "a", coordinates: { lat: 52.520, lng: 13.405 } },
    { id: "b", coordinates: { lat: 52.521, lng: 13.406 } },
    { id: "c", coordinates: { lat: 52.522, lng: 13.407 } }
  ]);
  await manager.prepareLayout(10);
  assert.equal(manager.getStats().clusterStrategy, "greedy");
  manager.destroy();

  const unlimited = objectManager({
    clusterize: true,
    clusterRadiusPixels: 256,
    clusterMaxZoom: 18,
    clusterHierarchyMaxObjects: 0,
    layoutWorker: false
  });
  unlimited.add([
    { id: "a", coordinates: { lat: 52.520, lng: 13.405 } },
    { id: "b", coordinates: { lat: 52.521, lng: 13.406 } },
    { id: "c", coordinates: { lat: 52.522, lng: 13.407 } }
  ]);
  await unlimited.prepareLayout(10);
  assert.equal(unlimited.getStats().clusterStrategy, "hierarchy");
  unlimited.destroy();
});
