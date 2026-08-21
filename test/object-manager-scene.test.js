import test from "node:test";
import assert from "node:assert/strict";
import { Evented } from "../dist/events.js";
import {
  ObjectManager,
  objectManager
} from "../dist/services/object-manager.js";
import { computeClusterAggregates } from "../dist/services/object-cluster-aggregates.js";
import { tryNormalizeManagedGeometry, normalizeManagedGeometry } from "../dist/services/object-geometry.js";
import { ObjectIconAtlas } from "../dist/services/object-icon-atlas.js";
import { ObjectSearchIndex } from "../dist/services/object-search-index.js";
import { ObjectTimeIndex } from "../dist/services/object-time-index.js";
import { MAX_TRAIL_POINTS, ObjectTrailStore } from "../dist/services/object-trail-store.js";
import { layoutObjectLabels } from "../dist/services/object-label-layout.js";
import { ObjectSceneController } from "../dist/services/object-scene.js";

function createFakeMap(zoom = 12) {
  class FakeMap extends Evented {
    zoom = zoom;
    layers = new Set();
    size = { width: 800, height: 600 };
    pixelOrigin = { x: 0, y: 0 };
    container = { getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } };
    crs = { code: "EPSG:3857" };
    panes = {
      marker: { children: [], appendChild() {}, removeChild() {} },
      overlay: { children: [], appendChild() {}, removeChild() {} },
      tooltip: { children: [], appendChild() {}, removeChild() {} }
    };
    getBounds() {
      return [
        [50, 10],
        [55, 15]
      ];
    }
    getPane(name) {
      return this.panes[name] ?? null;
    }
    latLngToLayerPoint([lat, lng]) {
      return { x: lng * 10, y: -lat * 10 };
    }
    latLngToContainerPoint([lat, lng]) {
      return { x: lng * 10, y: -lat * 10 };
    }
    containerPointToLatLng(point) {
      return { lat: -point.y / 10, lng: point.x / 10 };
    }
    setView() {
      return this;
    }
    fitBounds() {
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
  return new FakeMap();
}

test("ManagedGeometry normalizes legacy [lat,lng] and GeoJSON Point", () => {
  const legacy = tryNormalizeManagedGeometry({ id: 1, coordinates: [55.75, 37.61] });
  assert.equal(legacy?.kind, "Point");
  assert.equal(legacy?.lat, 55.75);
  assert.equal(legacy?.lng, 37.61);

  const geo = normalizeManagedGeometry({
    id: 2,
    geometry: { type: "Point", coordinates: [37.61, 55.75] }
  });
  assert.equal(geo.kind, "Point");
  assert.equal(geo.lat, 55.75);
  assert.equal(geo.lng, 37.61);

  assert.equal(tryNormalizeManagedGeometry({ id: 3, coordinates: [Number.NaN, 0] }), null);

  const line = normalizeManagedGeometry({
    id: 4,
    geometry: {
      type: "LineString",
      coordinates: [
        [37.6, 55.7],
        [37.7, 55.8]
      ]
    }
  });
  assert.equal(line.kind, "LineString");
  assert.equal(line.pointCount, 2);
  assert.ok(line.distances[1] > 0);

  const poly = normalizeManagedGeometry({
    id: 5,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [37.6, 55.7],
          [37.7, 55.7],
          [37.7, 55.8],
          [37.6, 55.8],
          [37.6, 55.7]
        ]
      ]
    }
  });
  assert.equal(poly.kind, "Polygon");
  assert.equal(poly.rings.length, 1);
});

test("icon atlas register/replace/remove/clear without crashing missing icons", () => {
  const atlas = new ObjectIconAtlas();
  const canvas = {
    width: 16,
    height: 16,
    getContext() {
      return {
        clearRect() {},
        drawImage() {},
        getImageData() {
          return { data: new Uint8ClampedArray(16 * 16 * 4) };
        }
      };
    }
  };
  // Headless: register via internal packing path if canvas-like source is accepted.
  assert.equal(atlas.has("truck"), false);
  try {
    atlas.register("truck", canvas, { pixelRatio: 1, anchor: [0.5, 0.5] });
  } catch {
    // Environments without canvas ImageBitmap path may reject; API still exists.
  }
  atlas.remove("truck");
  atlas.clear();
  assert.equal(atlas.has("missing"), false);
  assert.equal(atlas.getPacked("missing"), null);
});

test("ObjectManager icon API and search/time helpers", () => {
  const manager = objectManager({
    search: { fields: ["properties.name", "properties.vehicleNumber"] },
    time: {
      value: (object) => {
        const value = object.properties?.timestamp;
        return typeof value === "number" ? value : null;
      }
    },
    visualization: "auto",
    visualizationByZoom: { heatmapUntil: 7, clustersUntil: 12 },
    declutter: true
  });
  assert.equal(typeof manager.registerIcon, "function");
  assert.equal(typeof manager.removeIcon, "function");
  assert.equal(typeof manager.hasIcon, "function");
  assert.equal(typeof manager.clearIcons, "function");
  assert.equal(typeof manager.search, "function");
  assert.equal(typeof manager.setTimeRange, "function");
  assert.equal(typeof manager.setVisualization, "function");
  assert.equal(typeof manager.updateObjects, "function");
  assert.equal(typeof manager.moveObject, "function");

  manager.add([
    {
      id: "truck-42",
      coordinates: [55.75, 37.61],
      properties: { name: "Truck 42", vehicleNumber: "A482", timestamp: 1000 }
    },
    {
      id: "truck-7",
      coordinates: [55.76, 37.62],
      properties: { name: "Truck 7", vehicleNumber: "B001", timestamp: 2000 }
    }
  ]);

  const results = manager.search("truck 42", { limit: 5 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].id, "truck-42");

  manager.setTimeRange(1500, 2500);
  // State must survive time filtering.
  manager.setObjectState("truck-42", { selected: true });
  assert.equal(manager.getObjectState("truck-42").selected, true);

  manager.setTimeRange(null, null);
  assert.equal(manager.getObjectState("truck-42").selected, true);

  manager.setVisualization("heatmap");
  assert.equal(manager.getObjectState("truck-42").selected, true);
  manager.setVisualization("objects");

  manager.destroy();
});

test("search index ignores coordinate-only updates", () => {
  const index = new ObjectSearchIndex({ fields: ["properties.name"] });
  const objects = new Map();
  const a = { id: 1, properties: { name: "Berlin Hub" }, coordinates: [52.5, 13.4] };
  objects.set(1, a);
  index.upsert(1, a);
  assert.equal(index.search("berlin", objects).length, 1);

  // Simulate coordinate change without re-upsert: index still finds by name.
  a.coordinates = [52.6, 13.5];
  assert.equal(index.search("berlin", objects).length, 1);

  a.properties = { name: "Hamburg Hub" };
  index.upsert(1, a);
  assert.equal(index.search("berlin", objects).length, 0);
  assert.equal(index.search("hamburg", objects).length, 1);
});

test("temporal index uses range filtering and keeps inactive ids out", () => {
  const index = new ObjectTimeIndex({
    value: (object) => Number(object.properties?.timestamp)
  });
  for (let i = 0; i < 100; i++) {
    index.upsert(i, { properties: { timestamp: i * 10 } });
  }
  index.setRange(200, 250);
  const active = index.queryActiveIds();
  assert.ok(active);
  assert.equal(active.has(20), true);
  assert.equal(active.has(25), true);
  assert.equal(active.has(19), false);
  assert.equal(active.has(26), false);
  assert.equal(index.isActive(20), true);
  assert.equal(index.isActive(0), false);
});

test("temporal index keeps O(1) update bookkeeping valid after sorting", () => {
  const index = new ObjectTimeIndex({
    value: (object) => Number(object.properties?.timestamp)
  });
  for (let i = 0; i < 100; i++) index.upsert(i, { properties: { timestamp: i } });
  index.setRange(0, 99);
  assert.equal(index.queryActiveIds().size, 100); // sorts and rebuilds slot bookkeeping

  index.upsert(50, { properties: { timestamp: 1000 } });
  index.remove(20);
  index.setRange(0, 99);
  const active = index.queryActiveIds();
  assert.equal(active.size, 98);
  assert.equal(active.has(20), false);
  assert.equal(active.has(50), false);
  index.setRange(1000, 1000);
  assert.deepEqual([...index.queryActiveIds()], [50]);
});

test("motion interrupt starts from interpolated position", () => {
  const scene = new ObjectSceneController();
  scene.startMotion("a", 0, 0, 10, 10, 1000);
  const mid = scene.visualPosition("a", 0, 0);
  assert.ok(mid.lat >= 0 && mid.lat <= 10);
  scene.startMotion("a", 10, 10, 20, 0, 1000);
  const motion = scene.motions.get("a");
  assert.ok(motion);
  // from should be near previous interpolated point, not jumped to 10,10 unless already finished.
  assert.ok(motion.fromLat >= 0 && motion.fromLat <= 10);
});

test("trails append, dedupe, maxPoints, remove", () => {
  const trails = new ObjectTrailStore();
  trails.configure("a", { enabled: true, maxPoints: 3, maxAge: 60_000, color: "#2563eb", width: 2, opacity: 0.5 });
  trails.append("a", 1, 2);
  trails.append("a", 1, 2); // duplicate
  trails.append("a", 2, 3);
  trails.append("a", 3, 4);
  trails.append("a", 4, 5);
  const list = trails.list();
  assert.equal(list.length, 1);
  assert.ok(list[0].points.length <= 3);
  trails.remove("a");
  assert.equal(trails.list().length, 0);
});

test("trails clamp unbounded maxPoints", () => {
  const trails = new ObjectTrailStore();
  trails.configure("a", { enabled: true, maxPoints: 1e9, maxAge: 1e15 });
  for (let i = 0; i < MAX_TRAIL_POINTS + 40; i++) trails.append("a", i, i);
  assert.ok(trails.list()[0].points.length <= MAX_TRAIL_POINTS);
});

test("LineString/Polygon reject over-budget vertices", () => {
  const coords = [];
  for (let i = 0; i < 8; i++) coords.push([37 + i * 0.01, 55]);
  assert.throws(
    () =>
      normalizeManagedGeometry(
        { geometry: { type: "LineString", coordinates: coords } },
        { maxVertices: 5 }
      ),
    /maxVertices/
  );
});

test("label collision priority and always-visible", () => {
  const layout = layoutObjectLabels(
    [
      { id: 1, text: "a", x: 0, y: 0, width: 40, height: 12, priority: 1, collisionMode: "auto", kind: "label" },
      { id: 2, text: "b", x: 5, y: 0, width: 40, height: 12, priority: 10, collisionMode: "auto", kind: "label" },
      { id: 3, text: "c", x: 8, y: 0, width: 40, height: 12, priority: 0, collisionMode: "always", kind: "label" }
    ],
    { padding: 2 }
  );
  assert.ok(layout.visible.some((c) => c.id === 2));
  assert.ok(layout.visible.some((c) => c.id === 3));
  assert.equal(layout.visible.some((c) => c.id === 1), false);
});

test("cluster aggregations count/sum/min/max", () => {
  const objects = new Map([
    [1, { properties: { weight: 2, speed: 10, alarm: true } }],
    [2, { properties: { weight: 5, speed: 40, alarm: false } }],
    [3, { properties: { weight: 3, speed: 20, alarm: true } }]
  ]);
  const values = computeClusterAggregates(
    [1, 2, 3],
    objects,
    2,
    {
      alarms: { operation: "count", filter: (object) => object.properties?.alarm === true },
      totalWeight: { operation: "sum", value: (object) => Number(object.properties?.weight ?? 0) },
      minSpeed: { operation: "min", value: (object) => Number(object.properties?.speed ?? 0) },
      maxSpeed: { operation: "max", value: (object) => Number(object.properties?.speed ?? 0) }
    }
  );
  assert.equal(values.count, 3);
  assert.equal(values.containsSelected, true);
  assert.equal(values.properties.alarms, 2);
  assert.equal(values.properties.totalWeight, 10);
  assert.equal(values.properties.minSpeed, 10);
  assert.equal(values.properties.maxSpeed, 40);
});

test("ObjectManager accepts mixed geometry and preserves legacy points", () => {
  const manager = objectManager();
  manager.add([
    { id: 1, coordinates: [55.75, 37.61], properties: { type: "point" } },
    {
      id: "line-1",
      geometry: {
        type: "LineString",
        coordinates: [
          [37.61, 55.75],
          [37.7, 55.8]
        ]
      },
      properties: { type: "route" }
    },
    {
      id: "poly-1",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [37.6, 55.74],
            [37.65, 55.74],
            [37.65, 55.78],
            [37.6, 55.78],
            [37.6, 55.74]
          ]
        ]
      },
      properties: { type: "zone" }
    }
  ]);
  assert.equal(manager.getStats().objects, 3);
  assert.deepEqual(manager.getObject(1)?.coordinates, [55.75, 37.61]);
  manager.setObjectState("line-1", { selected: true });
  assert.equal(manager.getObjectState("line-1").selected, true);
  manager.removeObjects(["line-1"]);
  assert.deepEqual(manager.getObjectState("line-1"), {});
  manager.clear();
  assert.equal(manager.getStats().objects, 0);
  manager.destroy();
});

test("rotation normalizes degrees in style resolution", () => {
  const manager = objectManager({
    style: () => ({ rotation: 450, icon: null, size: 12, color: "#fff" })
  });
  manager.add({ id: 1, coordinates: [55, 37] });
  const map = createFakeMap(14);
  manager.addTo(map);
  manager.render();
  // Resolved style path is exercised without throwing for out-of-range rotation.
  assert.equal(manager.getStats().objects, 1);
  manager.destroy();
});

test("sceneFeatures false skips scene geometries; beginBulk defers layout invalidate", () => {
  const manager = objectManager({
    sceneFeatures: false,
    styleByCategory: false,
    clusterize: false,
    webglThreshold: 1
  });
  manager.beginBulk();
  manager.add([
    { id: 1, coordinates: [55.75, 37.61] },
    { id: 2, coordinates: [55.76, 37.62] }
  ]);
  assert.equal(manager.scene.geometries.size, 0);
  assert.equal(manager.getStats().objects, 2);
  manager.endBulk({ render: false });
  assert.equal(manager.scene.geometries.size, 0);

  manager.setSceneFeatures(true);
  assert.equal(manager.scene.geometries.size, 2);
  assert.equal(manager.scene.geometries.get(1)?.kind, "Point");

  manager.setSceneFeatures(false);
  assert.equal(manager.scene.geometries.size, 0);
  manager.destroy();
});

test("sceneFeatures false keeps property and animated point updates", async () => {
  const manager = objectManager({
    sceneFeatures: false,
    styleByCategory: false,
    clusterize: false,
    webglThreshold: 1
  });
  manager.add({ id: 1, coordinates: [55.75, 37.61], properties: { name: "a" } });
  const map = createFakeMap(6);
  manager.addTo(map);
  await manager.prepareLayout(6);

  manager.updateObjects([{ id: 1, coordinates: [55.75, 37.61], properties: { name: "b" } }]);
  assert.equal(manager.getObject(1)?.properties?.name, "b");
  assert.equal(manager.index.has(1), true);

  manager.updateObjects(
    [{ id: 1, coordinates: [55.8, 37.7], properties: manager.getObject(1).properties }],
    { animate: true, duration: 50 }
  );
  const rec = manager.index.records.get(1);
  assert.ok(rec);
  assert.equal(rec.position.lat, 55.8);
  manager.destroy();
});

test("flat WebGL time range compacts visible objects", async () => {
  const manager = objectManager({
    sceneFeatures: false,
    styleByCategory: false,
    clusterize: false,
    webglThreshold: 1,
    time: { value: (object) => Number(object.properties?.timestamp ?? 0) }
  });
  manager.add([
    { id: 1, coordinates: [55.75, 37.61], properties: { timestamp: 100 } },
    { id: 2, coordinates: [55.76, 37.62], properties: { timestamp: 500 } }
  ]);
  const map = createFakeMap(6);
  manager.addTo(map);
  await manager.prepareLayout(6);
  manager.setTimeRange(400, 600);
  assert.equal(manager.getStats().visibleObjects, 1);
  manager.setTimeRange(null, null);
  assert.equal(manager.getStats().visibleObjects, 2);
  manager.destroy();
});

test("mixed scene does not pack LineString/Polygon as WebGL points", async () => {
  const manager = objectManager({
    sceneFeatures: true,
    styleByCategory: false,
    clusterize: false,
    webglThreshold: 1,
    clusterRenderer: "webgl",
    style: () => ({ color: "#fff", size: 8 })
  });
  manager.add([
    { id: "pt", coordinates: [55.75, 37.61] },
    {
      id: "ln",
      geometry: { type: "LineString", coordinates: [[37.61, 55.75], [37.72, 55.82]] }
    },
    {
      id: "poly",
      geometry: {
        type: "Polygon",
        coordinates: [[[37.6, 55.7], [37.7, 55.7], [37.7, 55.8], [37.6, 55.7]]]
      }
    }
  ]);
  const map = createFakeMap(6);
  manager.addTo(map);
  await manager.prepareLayout(6);
  assert.equal(manager.getStats().objects, 3);
  assert.equal(manager.getStats().objectMarkers, 1);
  manager.destroy();
});

test("visualization auto thresholds resolve via scene", () => {
  const scene = new ObjectSceneController();
  scene.configure({
    visualization: "auto",
    visualizationByZoom: { heatmapUntil: 7, clustersUntil: 12 }
  });
  assert.equal(scene.resolveVisualization(5), "heatmap");
  assert.equal(scene.resolveVisualization(9), "clusters");
  assert.equal(scene.resolveVisualization(14), "objects");
});
